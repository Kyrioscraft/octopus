/**
 * Run registry — server-owned per-thread run state.
 *
 * Mirrors opencode's `session/run-state.ts` + `session/status.ts`: agent runs
 * belong to the SERVER, not to the HTTP response that started them. A client
 * disconnecting from the NDJSON stream only detaches a listener; the run keeps
 * executing, its events are buffered with a monotonic per-thread `seq`, and a
 * re-attaching client replays `seq > after` followed by the live tail
 * (opencode's durable `event.replay(aggregateID, after)` pattern, minus the
 * SQLite persistence — this buffer is in-memory only and dies with the
 * process, same as the MemorySaver checkpointer).
 *
 * No HTTP here — routes wrap this with transport (see routes/chat.ts).
 */

import { getLogger } from "@octopus/core";
import { getMaxThreadEventSeq } from "../db/index.js";

const logger = getLogger("run.registry");

export type RunStatus = "running" | "paused" | "done";

export interface BufferedReader {
  /** Monotonic per-thread sequence number. */
  seq: number;
  /** The NDJSON chunk as emitted to the original client. */
  chunk: Record<string, unknown>;
}

export interface RunState {
  threadId: string;
  status: RunStatus;
  /** Buffered events with monotonic seq (replay source for re-attach). */
  events: BufferedReader[];
  nextSeq: number;
  /** Live listeners — attach() adds, detach() removes. Never aborts the run. */
  listeners: Set<(e: BufferedReader) => void>;
  /** Aborts the underlying agent run (explicit stop only). */
  abort: AbortController;
  startedAt: number;
  /** Set once the buffer overflowed — gates the event_overflow marker to one. */
  overflowed?: boolean;
}

/** How long a finished run's buffer is kept for late re-attach/replay (ms). */
const RETAIN_MS = 30_000;

const runs = new Map<string, RunState>();
/** Timers cleaning up finished runs' buffers. */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startRun(threadId: string): RunState {
  // A previous run on the same thread (shouldn't happen — the UI blocks
  // concurrent sends) is superseded: abort it and take over.
  const prev = runs.get(threadId);
  if (prev) {
    prev.abort.abort();
    clearCleanupTimer(threadId);
  }
  const state: RunState = {
    threadId,
    status: "running",
    events: [],
    // Seed from the durable log so seq is globally monotonic PER THREAD —
    // a resume's events continue after the original turn's seqs instead of
    // colliding with them (PK conflicts on persist + client after= filters
    // eating overlapping live events). Falls back to 1 for a fresh thread.
    nextSeq: Math.max(1, getMaxThreadEventSeq(threadId) + 1),
    listeners: new Set(),
    abort: new AbortController(),
    startedAt: Date.now(),
  };
  runs.set(threadId, state);
  logger.info("Run started", { thread_id: threadId });
  return state;
}

export function getRun(threadId: string): RunState | undefined {
  return runs.get(threadId);
}

export function isRunning(threadId: string): boolean {
  const r = runs.get(threadId);
  // paused = waiting for HITL input — the turn is still "active" (not done):
  // the client must re-attach to restore the ask panel.
  return r !== undefined && (r.status === "running" || r.status === "paused");
}

/**
 * Record one chunk into the run's buffer and fan out to live listeners.
 * Returns the assigned per-thread seq (used by the route to persist the event
 * and stamp `seq` on the wire chunk). Listener errors (e.g. a listener's
 * response stream just closed) are caught per-listener and the listener is
 * dropped — a dead listener must never kill the run or the other listeners.
 */
export function recordEvent(state: RunState, chunk: Record<string, unknown>): number {
  const entry: BufferedReader = { seq: state.nextSeq++, chunk };
  state.events.push(entry);
  // Cap the buffer defensively (a runaway run shouldn't grow memory forever).
  // Keep the last 5000 events; earlier ones are still recoverable from the
  // durable thread_events log, but a live listener attached from seq 0 would
  // see a gap — mark it once so the client knows to fall back to replay from
  // storage (or /history) instead of silently missing events.
  if (state.events.length > 5000) {
    if (!state.overflowed) {
      state.overflowed = true;
      const marker: BufferedReader = {
        seq: state.nextSeq++,
        chunk: {
          type: "turn.error",
          errorType: "event_overflow",
          message: "事件缓冲溢出，早期事件已从内存移除；请从持久事件日志重放",
          threadId: state.threadId,
        },
      };
      state.events.push(marker);
      for (const listener of state.listeners) {
        try {
          listener(marker);
        } catch {
          state.listeners.delete(listener);
        }
      }
    }
    state.events.splice(0, state.events.length - 5000);
  }
  for (const listener of state.listeners) {
    try {
      listener(entry);
    } catch {
      state.listeners.delete(listener);
    }
  }
  return entry.seq;
}

/**
 * Mark a run paused (HITL interrupt — `ask_user_question_required` was the
 * last emitted chunk; the run is not executing but the turn isn't finished
 * either). The buffer stays so a re-entering client restores the ask panel.
 */
export function pauseRun(threadId: string): void {
  const r = runs.get(threadId);
  if (r && r.status === "running") r.status = "paused";
}

/**
 * Mark a run done (finished/error/interrupted-by-stop) and schedule buffer
 * cleanup. The buffer lingers RETAIN_MS so a client polling or re-attaching
 * right after completion still sees the terminal event.
 */
export function finishRun(threadId: string): void {
  const r = runs.get(threadId);
  if (!r) return;
  r.status = "done";
  for (const listener of r.listeners) {
    try {
      listener({ seq: r.nextSeq, chunk: { type: "idle", threadId } });
    } catch { /* dead listener — dropping below anyway */ }
  }
  r.listeners.clear();
  clearCleanupTimer(threadId);
  cleanupTimers.set(
    threadId,
    setTimeout(() => {
      runs.delete(threadId);
      cleanupTimers.delete(threadId);
    }, RETAIN_MS),
  );
  logger.info("Run finished", { thread_id: threadId });
}

function clearCleanupTimer(threadId: string): void {
  const t = cleanupTimers.get(threadId);
  if (t) {
    clearTimeout(t);
    cleanupTimers.delete(threadId);
  }
}

/**
 * Attach a live listener to a run. Returns a disposer (idempotent).
 * Returns undefined when the thread has no run entry.
 */
export function attachListener(
  threadId: string,
  after: number,
  onEvent: (e: BufferedReader) => void,
): (() => void) | undefined {
  const r = runs.get(threadId);
  if (!r) return undefined;
  // NOTE: replay of `seq > after` is done by the transport (route) BEFORE
  // calling this, to keep the enqueue order under its control. Race between
  // replay-snapshot and listener registration is closed here: registering the
  // listener first, then replaying, would double-deliver; instead the route
  // snapshots events, registers the listener, replays the snapshot, and drops
  // live entries already covered by the snapshot (identified by seq) — see
  // routes/chat.ts /events.
  r.listeners.add(onEvent);
  return () => {
    r.listeners.delete(onEvent);
  };
}

/** Explicitly abort a running/paused run (user pressed stop). */
export function abortRun(threadId: string): boolean {
  const r = runs.get(threadId);
  if (!r) return false;
  r.abort.abort();
  return true;
}
