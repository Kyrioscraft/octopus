/**
 * Run registry — server-owned per-thread run state.
 *
 * Mirrors opencode's `session/run-state.ts` + `session/status.ts`: agent runs
 * belong to the SERVER, not to the HTTP response that started them. A client
 * disconnecting only detaches a listener; the run keeps executing.
 *
 * Event flow is SINGLE-WRITE-PATH (opencode EventV2 semantics): the route
 * assigns a seq here, PERSISTS the event to the durable thread_events log,
 * and only then broadcasts to live listeners. There is no in-memory replay
 * buffer — the durable log is the single replay source, so the replay→live
 * handoff in GET /events is a pure monotonic-cursor filter, with no
 * identity-dedup or gap-fill.
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
  nextSeq: number;
  /** Live listeners — attach() adds, detach() removes. Never aborts the run. */
  listeners: Set<(e: BufferedReader) => void>;
  /** Aborts the underlying agent run (explicit stop only). */
  abort: AbortController;
  startedAt: number;
}

/** How long a finished run's entry is kept for late isRunning checks (ms). */
const RETAIN_MS = 30_000;

const runs = new Map<string, RunState>();
/** Timers cleaning up finished runs' entries. */
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
 * Assign the next per-thread seq. Pure — no buffering, no fan-out. The route
 * persists the event under this seq FIRST and broadcasts SECOND; that
 * ordering is what makes the durable log a superset of everything any
 * listener can receive, and lets /events close the replay→live race with a
 * monotonic cursor alone.
 */
export function assignSeq(state: RunState): number {
  return state.nextSeq++;
}

/**
 * Fan one persisted event out to the run's live listeners. Listener errors
 * (e.g. a listener's response stream just closed) are caught per-listener and
 * the listener is dropped — a dead listener must never kill the run or the
 * other listeners.
 */
export function broadcast(state: RunState, entry: BufferedReader): void {
  for (const listener of state.listeners) {
    try {
      listener(entry);
    } catch {
      state.listeners.delete(listener);
    }
  }
}

/**
 * Mark a run paused (HITL interrupt — an `ask` was the last emitted event;
 * the run is not executing but the turn isn't finished either). The registry
 * entry stays so a re-entering client restores the ask panel from the
 * durable log.
 */
export function pauseRun(threadId: string): void {
  const r = runs.get(threadId);
  if (r && r.status === "running") r.status = "paused";
}

/**
 * Mark a run done (finished/error/interrupted-by-stop) and schedule entry
 * cleanup. The entry lingers RETAIN_MS so a client re-attaching right after
 * completion still replays the terminal event from the durable log.
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
 *
 * Handoff contract with GET /events (single-write-path):
 *   1. attach the listener FIRST (collecting into a pending set),
 *   2. THEN snapshot the durable log from `after`,
 *   3. push the snapshot and advance a monotonic cursor to its max seq,
 *   4. from pending, push only entries with seq > cursor.
 * Because events are persisted BEFORE broadcast, every event delivered by
 * the listener between steps 1 and 2 is already in the snapshot — the cursor
 * filter drops the overlap exactly once, no identity set needed.
 */
export function attachListener(
  threadId: string,
  onEvent: (e: BufferedReader) => void,
): (() => void) | undefined {
  const r = runs.get(threadId);
  if (!r) return undefined;
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
