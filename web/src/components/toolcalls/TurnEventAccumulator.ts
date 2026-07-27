import type {
  ReasoningEvent,
  TextEvent,
  ToolEvent,
  SubagentEvent,
  AskEvent,
  TurnEvent,
  ToolCallEntry,
} from "./types.js";
import type { AskUserQuestionPayload } from "@octopus/tentacle";

/**
 * Accumulator that turns a stream of normalized wire chunks into an ordered
 * `TurnEvent[]` timeline.
 *
 * The core problem this solves: wire chunks arrive as a flat sequence of
 * tokens (reasoning / text / tool_call / tool_result), but the UI must render
 * them as an interleaved timeline that preserves real execution order. This
 * class owns the "when to start a new event vs. append to the current one"
 * logic so `doStream` stays readable.
 *
 * Usage:
 *   const acc = new TurnEventAccumulator();
 *   for (const chunk of stream) {
 *     acc.consume(chunk);
 *     setMsgs(prev => patchLast(prev, acc.events));
 *   }
 *
 * Event-boundary rules:
 *   - Reasoning tokens append to the current reasoning event; any non-reasoning
 *     chunk closes it (next reasoning chunk opens a new one).
 *   - Plain text tokens (no tool_calls, no tool_call_id, not reasoning, no
 *     agent_ns) append to the current text event; a tool_call or reasoning
 *     chunk closes it.
 *   - Each AI tool_call chunk creates one ToolEvent per call (idempotent on id).
 *   - A tool_result (ToolMessage) chunk finds its ToolEvent by tool_call_id and
 *     back-fills the result + marks done.
 *   - A subagent_started marker creates a SubagentEvent (idempotent on agentNs).
 */
export class TurnEventAccumulator {
  events: TurnEvent[] = [];

  /** Pointer to the currently-accumulating reasoning event, if any. */
  private curReasoning: ReasoningEvent | null = null;
  /** Pointer to the currently-accumulating text event, if any. */
  private curText: TextEvent | null = null;
  /** tool_call_id → ToolEvent index, for fast result back-fill. */
  private toolIndex = new Map<string, number>();
  /**
   * Streaming tool-call fragments arrive incrementally keyed by `index` (not
   * id — the id/name may only appear on the first fragment). This map tracks
   * the per-index accumulator state so we can update the matching ToolEvent
   * live as args stream in. Without this, the card shows "unknown" until the
   * turn finishes and the fully-aggregated message is persisted.
   */
  private streamingToolByIndex = new Map<
    string | number,
    { id: string; name: string; argsStr: string }
  >();
  private seq = 0;

  private nextId(prefix: string): string {
    return `${prefix}_${Date.now()}_${this.seq++}`;
  }

  /** Reset between turns (a fresh accumulator is usually created per turn). */
  reset(): void {
    this.events = [];
    this.curReasoning = null;
    this.curText = null;
    this.toolIndex.clear();
    this.streamingToolByIndex.clear();
  }

  /**
   * Record an `ask_user_question_required` chunk as a read-only AskEvent in
   * the timeline. The interactive UI lives in the input-area AskPanel — this
   * only leaves a causal trace ("the agent paused here to ask me something").
   *
   * Callers may later call `resolveAsk` to flip the latest unresolved AskEvent
   * to `resolved=true` with the user's submitted body, so the row collapses
   * to an outcome summary.
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
   * none. Called by Chat.tsx after the user submits the AskPanel.
   */
  resolveAsk(resolution: import("@octopus/tentacle").ResumeRequestBody): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.type === "ask" && !ev.resolved) {
        this.events[i] = { ...ev, resolved: true, resolution };
        return;
      }
    }
  }

  /**
   * Consume one normalized chunk. Mutates `this.events` in place; callers
   * should treat the array as replaced (we return a shallow copy via
   * `snapshot()` for React state updates).
   */
  consume(chunk: {
    msgType?: string;
    text: string;
    isReasoning: boolean;
    toolCalls?: Array<Record<string, unknown>>;
    /** Streaming tool-call fragments (tool_call_chunks), keyed by `index`. */
    toolCallChunks?: Array<{
      name?: string;
      args?: string;
      index?: string | number;
      id?: string;
    }>;
    toolCallId?: string;
    agentNs?: string;
    /** For subagent_started markers. */
    description?: string;
  }): void {
    const { msgType, text, isReasoning, toolCalls, toolCallChunks, toolCallId, agentNs, description } = chunk;

    // --- Subagent lifecycle marker (emitted by engine.ts on `task` tool) ---
    if (msgType === "subagent_started") {
      this.closeText();
      const ns = agentNs ?? "";
      // Idempotent: one SubagentEvent per agentNs.
      if (!this.events.some((e) => e.type === "subagent" && e.agentNs === ns)) {
        const ev: SubagentEvent = {
          id: this.nextId("sa"),
          type: "subagent",
          agentNs: ns,
          description: description ?? "",
        };
        this.events.push(ev);
      }
      return;
    }

    // --- ToolMessage (tool result): back-fill into the matching ToolEvent ---
    if (msgType === "tool") {
      this.closeText();
      this.closeReasoning();
      if (toolCallId) {
        const idx = this.toolIndex.get(toolCallId);
        if (idx !== undefined) {
          const ev = this.events[idx];
          if (ev?.type === "tool") {
            ev.entry = {
              ...ev.entry,
              status: "done",
              result: (ev.entry.result ?? "") + text,
            };
          }
        }
      }
      // Orphan tool results (no matching pending call) are dropped.
      return;
    }

    // --- AI message carrying tool_calls: register each as a ToolEvent ---
    // NOTE: the first streaming chunk of a tool call often carries BOTH a
    // complete tool_calls entry (with name + id) AND a tool_call_chunks entry.
    // We register each call here AND seed streamingToolByIndex (keyed by array
    // position) so that later tool_call_chunks fragments — which arrive with
    // only `index` and partial `args`, no `id` or `name` — can find and update
    // the SAME ToolEvent instead of creating a stray "unknown" one.
    if (toolCalls && toolCalls.length > 0) {
      this.closeText();
      this.closeReasoning();
      toolCalls.forEach((tc, arrayIndex) => {
        const id = (tc.id as string) ?? this.nextId("tc");
        const name = (tc.name as string) ?? "unknown";
        const args = (tc.args as Record<string, unknown>) ?? {};
        if (!this.toolIndex.has(id)) {
          const ev: ToolEvent = {
            id: `te_${id}`,
            type: "tool",
            entry: { id, name, args, status: "pending", ...(agentNs ? { agentNs } : {}) },
          };
          this.toolIndex.set(id, this.events.length);
          this.events.push(ev);
        }
        // Seed the index→bucket map so subsequent tool_call_chunks (which lack
        // id/name, carrying only index + args fragments) update THIS event.
        // OpenAI's streaming protocol uses the tool-call's array position as
        // the `index`, so we use arrayIndex here.
        if (!this.streamingToolByIndex.has(arrayIndex)) {
          this.streamingToolByIndex.set(arrayIndex, {
            id,
            name,
            // If the complete tool_call already parsed args, seed argsStr from
            // it so tryParsePartialJson doesn't start from empty.
            argsStr: Object.keys(args).length > 0 ? JSON.stringify(args) : "",
          });
        }
      });
      return;
    }

    // --- Streaming tool-call fragments (tool_call_chunks) ---
    // These arrive incrementally during streaming: the first fragment usually
    // carries the tool `name`, and `args` dribbles in as partial JSON strings
    // keyed by `index`. We accumulate per-index and update the matching
    // ToolEvent live, so the card shows the real tool name (not "unknown")
    // and progressively fills in arguments as they stream.
    if (toolCallChunks && toolCallChunks.length > 0) {
      this.closeText();
      this.closeReasoning();
      for (const tcc of toolCallChunks) {
        const idx = tcc.index ?? 0;
        let bucket = this.streamingToolByIndex.get(idx);
        if (!bucket) {
          // First fragment for this index: create the ToolEvent immediately
          // so the card appears (with the name if the fragment has it).
          const id = tcc.id ?? this.nextId("tcc");
          const name = tcc.name ?? "unknown";
          bucket = { id, name, argsStr: "" };
          this.streamingToolByIndex.set(idx, bucket);
          if (!this.toolIndex.has(id)) {
            const ev: ToolEvent = {
              id: `te_${id}`,
              type: "tool",
              entry: { id, name, args: {}, status: "pending", ...(agentNs ? { agentNs } : {}) },
            };
            this.toolIndex.set(id, this.events.length);
            this.events.push(ev);
          }
        }
        // Subsequent fragments may carry the name (if the first didn't) and
        // append to the args string.
        if (tcc.name) bucket.name = tcc.name;
        if (tcc.args) bucket.argsStr += tcc.args;
        // Update the ToolEvent in place: name (may transition unknown→real)
        // and args (when the accumulated JSON parses successfully).
        const teIdx = this.toolIndex.get(bucket.id);
        if (teIdx !== undefined) {
          const ev = this.events[teIdx];
          if (ev?.type === "tool") {
            const parsed = tryParsePartialJson(bucket.argsStr);
            ev.entry = {
              ...ev.entry,
              name: bucket.name,
              ...(parsed ? { args: parsed } : {}),
            };
          }
        }
      }
      return;
    }

    // --- Subagent tokens (agent_ns set, non-tool): route to subagent result ---
    // We don't surface the subagent's internal stream as separate events
    // (flat design). Its final result arrives via the task tool's ToolMessage,
    // which is handled by the tool-result branch above.
    if (agentNs) {
      // Find the matching SubagentEvent and accumulate its result text.
      // (Typically the result comes via ToolMessage, but if the engine emits
      // the subagent's text directly with agent_ns, capture it here too.)
      for (let i = this.events.length - 1; i >= 0; i--) {
        const ev = this.events[i];
        if (ev.type === "subagent" && ev.agentNs === agentNs) {
          ev.result = (ev.result ?? "") + text;
          break;
        }
      }
      return;
    }

    // --- Reasoning tokens ---
    if (isReasoning) {
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
      this.curReasoning.text += text;
      return;
    }

    // --- Plain text (the final reply) ---
    this.closeReasoning();
    if (!this.curText) {
      this.curText = {
        id: this.nextId("tx"),
        type: "text",
        text: "",
      };
      this.events.push(this.curText);
    }
    this.curText.text += text;
  }

  /** Close the currently-open reasoning event (if any). */
  private closeReasoning(): void {
    this.curReasoning = null;
  }

  /** Close the currently-open text event (if any). */
  private closeText(): void {
    this.curText = null;
  }

  /**
   * Mark any still-pending tool events as done (call when the turn finishes
   * cleanly — a pending call whose result never arrived is assumed complete).
   */
  finalizeDone(): void {
    for (const ev of this.events) {
      if (ev.type === "tool" && (ev.entry.status === "pending" || ev.entry.status === "running")) {
        ev.entry = { ...ev.entry, status: "done" };
      }
    }
  }

  /**
   * Mark any still-pending tool events as errored (call when the turn ends
   * with an error).
   */
  finalizeError(): void {
    for (const ev of this.events) {
      if (ev.type === "tool" && (ev.entry.status === "pending" || ev.entry.status === "running")) {
        ev.entry = { ...ev.entry, status: "error" };
      }
    }
  }

  /** Shallow copy of events for React state (entries are replaced immutably
   *  inside `consume`, so a shallow slice is enough to trigger re-render). */
  snapshot(): TurnEvent[] {
    return this.events.slice();
  }
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
 * Derive the legacy `reasoning` string (concatenation of all reasoning events).
 */
export function reasoningFromEvents(events: TurnEvent[] | undefined): string {
  if (!events) return "";
  return events
    .filter((e): e is ReasoningEvent => e.type === "reasoning")
    .map((e) => e.text)
    .join("");
}

/**
 * Attempt to parse a (possibly partial) JSON object string accumulated from
 * streaming tool-call fragments. Returns the parsed object on success, or
 * `null` while the JSON is still incomplete (the streaming args string looks
 * like `{"file_path": "foo` mid-stream and only becomes valid once the final
 * fragment arrives).
 *
 * This is the industry-standard approach for streaming tool args (yuxi/Aider
 * do the same): keep the last successfully-parsed value, and only update when
 * a new parse succeeds. No external dependency — just JSON.parse with a guard.
 */
function tryParsePartialJson(s: string): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
