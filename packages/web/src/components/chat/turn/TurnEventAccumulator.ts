import type {
  ReasoningEvent,
  TextEvent,
  ToolEvent,
  SubagentEvent,
  AskEvent,
  TurnEvent,
} from "./types.js";
import type { ToolCallEntry } from "../rows/tools/types.js";
import type { AskUserQuestionPayload, StreamEvent, ResumeRequestBody } from "@octopus/tentacle";

/**
 * Accumulator that turns a stream of typed StreamEvents into an ordered
 * `TurnEvent[]` timeline.
 *
 * v2 protocol: every incoming event carries stable correlation ids
 * (`messageId` / `toolCallId` / `instanceKey`), so this class only has to
 * locate the matching timeline entry and append/patch — no heuristics, no
 * client-side JSON reassembly (tool args arrive pre-parsed from the engine),
 * no placeholder rebinding (subagent.started carries callId; internal chunks
 * carry the resolved instanceKey and bind on first sight).
 *
 * Event-boundary rules (unchanged in spirit from v1):
 *   - reasoning.delta appends to the current reasoning event; any other event
 *     type closes it (next reasoning opens a new one). Same for text.delta.
 *   - tool.started creates one ToolEvent per toolCallId (idempotent);
 *     tool.args.delta appends raw args fragments; tool.result back-fills the
 *     result and marks done.
 *   - subagent.started creates a SubagentEvent (idempotent on key);
 *     subagent.finished marks done.
 */
export class TurnEventAccumulator {
  events: TurnEvent[] = [];

  /** Pointer to the currently-accumulating reasoning event, if any. */
  private curReasoning: ReasoningEvent | null = null;
  /** Pointer to the currently-accumulating text event, if any. */
  private curText: TextEvent | null = null;
  /**
   * The most recently closed (but not yet terminated by its `*.ended` event)
   * reasoning/text event — a live `*.ended` arriving after an interleaved
   * close must normalize THAT event (not open a new one), or the turn shows
   * the deltas AND the full text as two blocks.
   */
  private lastClosedReasoning: ReasoningEvent | null = null;
  private lastClosedText: TextEvent | null = null;
  /** toolCallId → ToolEvent index, for fast result back-fill. */
  private toolIndex = new Map<string, number>();
  /** toolCallId → accumulated args JSON string (parsed lazily per delta). */
  private toolArgs = new Map<string, string>();
  /**
   * Active subagents keyed by instanceKey (`pending:<callId>` or
   * `tools:<run-id>`), each owning an inner accumulator for its nested
   * timeline. callId → key lets the first internal chunk (which carries the
   * resolved `tools:<run-id>` as agentNs) bind to the right SubagentEvent.
   */
  private subagentIndex = new Map<string, { eventIdx: number; innerAcc: TurnEventAccumulator; callId?: string }>();
  private seq = 0;

  private nextId(prefix: string): string {
    return `${prefix}_${Date.now()}_${this.seq++}`;
  }

  /** Reset between turns (a fresh accumulator is usually created per turn). */
  reset(): void {
    this.events = [];
    this.curReasoning = null;
    this.curText = null;
    this.lastClosedReasoning = null;
    this.lastClosedText = null;
    this.toolIndex.clear();
    this.toolArgs.clear();
    this.subagentIndex.clear();
  }

  /**
   * Record an `ask` event as a read-only AskEvent in the timeline. The
   * interactive UI lives in the input-area AskPanel — this only leaves a
   * causal trace ("the agent paused here to ask me something").
   */
  consumeAskReadOnly(payload: AskUserQuestionPayload): void {
    this.closeText();
    this.closeReasoning();
    const ev: AskEvent = {
      id: this.nextId("ask"),
      type: "ask",
      kind: payload.kind,
      questions: payload.questions,
    };
    this.events.push(ev);
  }

  /**
   * Mark the most recent unresolved AskEvent as resolved. No-op if there is
   * none. Called by useChat after the user submits the AskPanel.
   */
  resolveAsk(resolution: ResumeRequestBody): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.type === "ask" && !ev.resolved) {
        this.events[i] = { ...ev, resolved: true, resolution };
        return;
      }
    }
  }

  /**
   * Consume one typed wire event. Mutates `this.events` in place; callers
   * should treat the array as replaced (we return a shallow copy via
   * `snapshot()` for React state updates).
   */
  consume(ev: StreamEvent): void {
    switch (ev.type) {
      case "turn.started":
      case "turn.finished":
      case "turn.error":
      case "turn.interrupted":
      case "ask":
      case "idle":
      case "heartbeat":
        // Lifecycle events are handled by useChat directly, not the timeline.
        return;

      case "subagent.started": {
        this.closeText();
        const key = ev.instanceKey;
        if (!this.subagentIndex.has(key)) {
          const eventIdx = this.events.length;
          const sa: SubagentEvent = {
            id: this.nextId("sa"),
            type: "subagent",
            agentNs: key,
            displayName: ev.subagentName,
            description: ev.description ?? "",
            events: [],
            status: "streaming",
          };
          this.events.push(sa);
          this.subagentIndex.set(key, { eventIdx, innerAcc: new TurnEventAccumulator(), callId: ev.callId });
        }
        return;
      }

      case "subagent.finished": {
        const entry = this.subagentIndex.get(ev.instanceKey);
        if (entry) {
          const sa = this.events[entry.eventIdx];
          if (sa?.type === "subagent") sa.status = "done";
        }
        return;
      }

      case "tool.started": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeText();
        this.closeReasoning();
        if (!this.toolIndex.has(ev.toolCallId)) {
          const te: ToolEvent = {
            id: `te_${ev.toolCallId}`,
            type: "tool",
            entry: { id: ev.toolCallId, name: ev.name, args: {}, status: "pending" },
          };
          this.toolIndex.set(ev.toolCallId, this.events.length);
          this.toolArgs.set(ev.toolCallId, "");
          this.events.push(te);
        }
        return;
      }

      case "tool.args.delta": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeText();
        this.closeReasoning();
        const idx = this.toolIndex.get(ev.toolCallId);
        if (idx === undefined) return; // args before started (task tool) — ignored
        const acc = (this.toolArgs.get(ev.toolCallId) ?? "") + ev.argsDelta;
        this.toolArgs.set(ev.toolCallId, acc);
        const te = this.events[idx];
        if (te?.type === "tool") {
          const parsed = parsePartialJson(acc);
          te.entry = { ...te.entry, ...(parsed ? { args: parsed } : {}) };
        }
        return;
      }

      case "tool.result": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeText();
        this.closeReasoning();
        const idx = this.toolIndex.get(ev.toolCallId);
        if (idx === undefined) return; // `task` result — subagent row owns it
        const te = this.events[idx];
        if (te?.type === "tool") {
          te.entry = {
            ...te.entry,
            status: ev.isError ? "error" : "done",
            result: ev.result,
          };
        }
        return;
      }

      case "reasoning.delta": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeText();
        if (!this.curReasoning) {
          this.curReasoning = {
            id: this.nextId("rs"),
            type: "reasoning",
            text: "",
            startedAt: Date.now(),
          };
          this.events.push(this.curReasoning);
        }
        this.curReasoning.text += ev.delta;
        return;
      }

      case "text.delta": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeReasoning();
        if (!this.curText) {
          this.curText = { id: this.nextId("tx"), type: "text", text: "" };
          this.events.push(this.curText);
        }
        this.curText.text += ev.delta;
        return;
      }

      // ---- terminal full-value events (replayable boundary) --------------
      // On replay from storage, only these arrive (deltas are compacted
      // away) — they must be able to reconstruct the timeline standalone.
      // Live, they arrive AFTER the deltas and normalize the accumulated
      // value to the authoritative full text (covers any missed deltas).
      case "reasoning.ended": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeText();
        // Live: the open (or just-closed by an interleaved event) reasoning
        // episode is normalized in place to the authoritative full text.
        // Replay: no deltas arrived, so open a fresh event.
        const target = this.curReasoning ?? this.lastClosedReasoning;
        if (target) {
          target.text = ev.text;
          if (target.endedAt === undefined) target.endedAt = Date.now();
          this.lastClosedReasoning = null;
        } else {
          this.curReasoning = {
            id: this.nextId("rs"),
            type: "reasoning",
            text: ev.text,
            startedAt: Date.now(),
          };
          this.events.push(this.curReasoning);
          this.closeReasoning();
        }
        return;
      }

      case "text.ended": {
        if (ev.agentNs) {
          this.innerConsume(ev.agentNs, ev, (inner) => inner.consume(stripNs(ev)));
          return;
        }
        this.closeReasoning();
        // Same in-place normalization as reasoning.ended — see above.
        const target = this.curText ?? this.lastClosedText;
        if (target) {
          target.text = ev.text;
          this.lastClosedText = null;
        } else {
          this.curText = { id: this.nextId("tx"), type: "text", text: ev.text };
          this.events.push(this.curText);
          this.closeText();
        }
        return;
      }
    }
  }

  /**
   * Forward a subagent-internal event to its inner accumulator and sync the
   * nested snapshot back into the SubagentEvent. Binds the resolved
   * `tools:<run-id>` key to the pending `pending:<callId>` SubagentEvent on
   * first sight (identified via the engine's callId correlation — but since
   * internal chunks only carry the instance key, fall back to FIFO binding of
   * the earliest pending entry).
   */
  private innerConsume(
    agentNs: string,
    _ev: StreamEvent,
    feed: (inner: TurnEventAccumulator) => void,
  ): void {
    let entry = this.subagentIndex.get(agentNs);
    if (!entry) {
      // Bind the earliest still-streaming pending subagent (the engine emits
      // FIFO; task blocks so only one is streaming at a time in practice).
      for (const [key, e] of this.subagentIndex) {
        const sa = this.events[e.eventIdx];
        if (sa?.type === "subagent" && sa.status === "streaming" && key.startsWith("pending:")) {
          // Re-key the index entry under the resolved instance key.
          this.subagentIndex.delete(key);
          sa.agentNs = agentNs;
          this.subagentIndex.set(agentNs, e);
          entry = e;
          break;
        }
      }
      if (!entry) return; // genuinely orphan internal chunk — drop
    }
    feed(entry.innerAcc);
    const sa = this.events[entry.eventIdx];
    if (sa?.type === "subagent") {
      sa.events = entry.innerAcc.snapshot();
    }
  }

  /** Close the currently-open reasoning event (if any), freezing its duration. */
  private closeReasoning(): void {
    if (this.curReasoning) {
      this.curReasoning.endedAt = Date.now();
      this.lastClosedReasoning = this.curReasoning;
      this.curReasoning = null;
    }
  }

  /** Close the currently-open text event (if any). */
  private closeText(): void {
    if (this.curText) {
      this.lastClosedText = this.curText;
      this.curText = null;
    }
  }

  /**
   * Mark any still-pending tool events as done (call when the turn finishes
   * cleanly — a pending call whose result never arrived is assumed complete).
   * Recurses into nested subagent accumulators so their timelines finalize too.
   */
  finalizeDone(): void {
    for (const ev of this.events) {
      if (ev.type === "tool" && (ev.entry.status === "pending" || ev.entry.status === "running")) {
        ev.entry = { ...ev.entry, status: "done" };
      }
      if (ev.type === "subagent") {
        ev.status = "done";
      }
    }
    for (const { innerAcc, eventIdx } of this.subagentIndex.values()) {
      innerAcc.finalizeDone();
      const ev = this.events[eventIdx];
      if (ev?.type === "subagent") ev.events = innerAcc.snapshot();
    }
  }

  /**
   * Mark any still-pending tool events as errored (call when the turn ends
   * with an error). Recurses into nested subagent accumulators.
   */
  finalizeError(): void {
    for (const ev of this.events) {
      if (ev.type === "tool" && (ev.entry.status === "pending" || ev.entry.status === "running")) {
        ev.entry = { ...ev.entry, status: "error" };
      }
      if (ev.type === "subagent") {
        ev.status = "done";
      }
    }
    for (const { innerAcc, eventIdx } of this.subagentIndex.values()) {
      innerAcc.finalizeError();
      const ev = this.events[eventIdx];
      if (ev?.type === "subagent") ev.events = innerAcc.snapshot();
    }
  }

  /** Shallow copy of events for React state. */
  snapshot(): TurnEvent[] {
    return this.events.slice();
  }
}

/** Strip agentNs from an event before forwarding to a subagent's inner
 *  accumulator (inside it, the chunk must behave like a main-timeline event). */
function stripNs<T extends { agentNs?: string }>(ev: T): T {
  const { agentNs: _drop, ...rest } = ev;
  return rest as T;
}

/**
 * Derive the legacy `content` string from a timeline (concatenation of text
 * events). Used to keep Msg.content in sync for any code that still reads it
 * (e.g. persistence, fallback rendering).
 */
export function contentFromEvents(events: TurnEvent[] | undefined): string {
  if (!events) return "";
  return events.filter((e): e is TextEvent => e.type === "text").map((e) => e.text).join("");
}

/**
 * Parse a (possibly partial) JSON object string accumulated from streaming
 * tool-args deltas. Tries `JSON.parse` first; on failure progressively
 * extracts completed `"key": value` pairs so the UI can show e.g. file_path
 * as soon as its value finishes streaming. Returns null when nothing useful
 * can be extracted yet.
 */
function parsePartialJson(s: string): Record<string, unknown> | null {
  if (!s || !s.trim()) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    /* fall through to progressive extraction */
  }
  const result: Record<string, unknown> = {};
  const strRe = /"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(s)) !== null) {
    result[m[1]] = m[3];
  }
  const primRe = /"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:\s*)(-?\d+(?:\.\d+)?|true|false|null)/g;
  while ((m = primRe.exec(s)) !== null) {
    const key = m[1];
    if (key in result) continue;
    const raw = m[3];
    if (raw === "true") result[key] = true;
    else if (raw === "false") result[key] = false;
    else if (raw === "null") result[key] = null;
    else result[key] = Number(raw);
  }
  return Object.keys(result).length > 0 ? result : null;
}
