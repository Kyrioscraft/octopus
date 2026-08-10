import type {
  ReasoningEvent,
  TextEvent,
  ToolEvent,
  SubagentEvent,
  AskEvent,
  TurnEvent,
} from "./types.js";
import type { ToolCallEntry } from "../rows/tools/types.js";
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
   * Per-tool-call streaming state, keyed by the tool call's unique `id` (not
   * `index` — OpenAI reuses index 0,1,... for every new call in the same turn).
   * Each bucket accumulates the args JSON fragments until they can be parsed.
   */
  private streamingBuckets = new Map<
    string,
    { id: string; name: string; argsStr: string }
  >();
  /**
   * Bridge: OpenAI `index` (0,1,...) → tool call `id`. Set when a `tool_calls`
   * delta arrives (which carries both id and array position = index). Used by
   * later chunk-only deltas (which carry only index, no id) to find the right
   * bucket.
   */
  private indexToBucketId = new Map<number, string>();
  /**
   * Active subagents, keyed by agentNs. Each subagent owns its own internal
   * TurnEventAccumulator so its reasoning/tool/text steps render as a nested
   * timeline (recursively — subagents-within-subagents work automatically).
   * `eventIdx` is the index of the SubagentEvent in `this.events`, so we can
   * sync the inner accumulator's snapshot back into it on every inner update.
   */
  private subagentIndex = new Map<string, { eventIdx: number; innerAcc: TurnEventAccumulator }>();
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
    this.streamingBuckets.clear();
    this.indexToBucketId.clear();
    this.subagentIndex.clear();
  }

  /**
   * Rebind the most recent pending SubagentEvent to the real instance key.
   *
   * "Pending" = a SubagentEvent created by `subagent_started` under a PLACEHOLDER
   * key (`pending:<toolCallId>`), whose inner timeline is still empty. The real
   * per-invocation key (`tools:<run-id>`, from the checkpoint namespace) is only
   * learned once the subgraph streams its first internal chunk. When that chunk
   * arrives, we rebind the latest pending SubagentEvent from its placeholder to
   * `realAgentNs`, so all of that invocation's chunks nest under one key. We
   * also capture the display name if provided.
   *
   * Returns true if a rebinding happened, false if no pending SubagentEvent
   * was found (the caller then treats the chunk as an orphan).
   */
  private rebindPendingSubagent(realAgentNs: string, displayName?: string): boolean {
    // Walk events in reverse to find the latest pending SubagentEvent.
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev?.type !== "subagent") continue;
      if (ev.events.length > 0) continue; // already receiving internal events
      const oldKey = ev.agentNs;
      if (oldKey === realAgentNs) return true; // already correctly keyed
      // Rebind: update the event's agentNs to the real instance key. The
      // display name from an internal chunk (the ACTUALLY-executed subagent
      // type, e.g. "Explore") is more accurate than the one from
      // subagent_started (the REQUESTED type, e.g. "general-purpose"), so we
      // overwrite it whenever a real name is available.
      this.events[i] = {
        ...ev,
        agentNs: realAgentNs,
        ...(displayName ? { displayName } : {}),
      };
      const entry = this.subagentIndex.get(oldKey);
      if (entry) {
        this.subagentIndex.delete(oldKey);
        this.subagentIndex.set(realAgentNs, entry);
      } else {
        // No index entry yet (shouldn't happen since subagent_started creates
        // one), create it defensively.
        this.subagentIndex.set(realAgentNs, { eventIdx: i, innerAcc: new TurnEventAccumulator() });
      }
      return true;
    }
    return false;
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
    /** Display name for subagent chunks (lc_agent_name / subagent_type). */
    agentName?: string;
    /** For subagent_started markers. */
    description?: string;
  }): void {
    const { msgType, text, isReasoning, toolCalls, toolCallChunks, toolCallId, agentNs, agentName, description } = chunk;

    // --- Subagent lifecycle markers (emitted by engine.ts on `task` tool) ---
    if (msgType === "subagent_started") {
      this.closeText();
      // agentNs here is a PLACEHOLDER key (`pending:<toolCallId>`) — the real
      // per-invocation key (`tools:<run-id>`) is learned from the first internal
      // chunk and applied via rebindPendingSubagent.
      const ns = agentNs ?? "";
      if (!this.subagentIndex.has(ns)) {
        const eventIdx = this.events.length;
        const ev: SubagentEvent = {
          id: this.nextId("sa"),
          type: "subagent",
          agentNs: ns,
          displayName: agentName,
          description: description ?? "",
          events: [],
          status: "streaming",
        };
        this.events.push(ev);
        this.subagentIndex.set(ns, { eventIdx, innerAcc: new TurnEventAccumulator() });
      }
      return;
    }
    if (msgType === "subagent_finished") {
      // agentNs here is the RESOLVED instance key (tools:<run-id>), matched by
      // the backend's placeholder→instance map. Look it up directly.
      const ns = agentNs ?? "";
      const entry = this.subagentIndex.get(ns);
      if (entry) {
        const ev = this.events[entry.eventIdx];
        if (ev?.type === "subagent") {
          ev.status = "done";
        }
      }
      return;
    }

    // --- Delegate to a subagent's inner accumulator ---
    // Any chunk carrying an active subagent's agentNs (token / tool_call /
    // tool_result / reasoning emitted from inside the subagent) is forwarded
    // to that subagent's own TurnEventAccumulator, then its snapshot is synced
    // back into the SubagentEvent.events. This produces a nested timeline and
    // works recursively for subagents-within-subagents.
    //
    // Rebinding: `subagent_started` created the SubagentEvent under a PLACEHOLDER
    // key (`pending:<toolCallId>`) because the real per-invocation key isn't
    // known until the subgraph streams. The real key is `tools:<run-id>` (from
    // LangGraph's checkpoint namespace, carried here as agentNs). When the first
    // internal chunk arrives, we rebind the most recent pending SubagentEvent
    // from its placeholder to this real key, so subsequent chunks nest under it.
    // We also capture the display name (agentName) if not already set.
    if (agentNs && !this.subagentIndex.has(agentNs)) {
      const rebound = this.rebindPendingSubagent(agentNs, agentName);
      if (!rebound && !msgType?.startsWith("subagent_")) {
        // No pending SubagentEvent to rebind — this is a genuinely orphan
        // subagent chunk (subagent_started marker was missed). Drop it rather
        // than polluting the main timeline with a subagent's internal text.
        return;
      }
    }
    if (agentNs && this.subagentIndex.has(agentNs)) {
      const entry = this.subagentIndex.get(agentNs)!;
      // Forward to the subagent's INNER accumulator. CRITICAL: strip agentNs /
      // agentName from the chunk, otherwise the inner accumulator's own
      // consume() would (at line ~248) treat the chunk's agentNs as a foreign
      // subagent key, fail to rebind it, and drop the chunk as an "orphan" —
      // emptying the subagent's internal timeline. Inside the inner
      // accumulator the chunk must behave like a plain main-timeline event.
      const { agentNs: _dropNs, agentName: _dropName, ...inner } = chunk;
      entry.innerAcc.consume(inner);
      const ev = this.events[entry.eventIdx];
      if (ev?.type === "subagent") {
        // The display name from an internal chunk (actually-executed type) is
        // more accurate than the requested type from subagent_started, so
        // overwrite it whenever a real name is available.
        if (agentName) ev.displayName = agentName;
        ev.events = entry.innerAcc.snapshot();
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
      // The `task` tool's ToolMessage has no matching ToolEvent (we skip
      // registering `task` calls) and carries no agentNs (it's the main
      // agent receiving the result). It is dropped here — the subagent's
      // final report is already captured in its inner timeline, and the
      // collapsed summary uses the tool count + status instead.
      // Orphan tool results (no matching pending call) are dropped.
      return;
    }

    // --- AI message carrying tool_calls and/or tool_call_chunks ---
    //
    // Streaming reality (OpenAI/DeepSeek/...): the FIRST delta of a tool call
    // carries BOTH a complete `tool_calls` entry (with name + id) AND a
    // `tool_call_chunks` entry (with name + id + index + partial args).
    // Subsequent deltas carry ONLY `tool_call_chunks` (no name/id, same index,
    // more args fragments).
    //
    // The tricky part: OpenAI reuses `index` (0, 1, ...) across separate tool
    // calls in the same turn. So a second tool call's first delta also has
    // `index: 0`. If we keyed buckets purely by `index`, the second call's
    // args would append to the first call's argsStr (concatenating two JSON
    // objects). We solve this by keying on `id` (unique per call) and using
    // `index` only as a transient bridge inside the same delta.
    const hasToolCalls = toolCalls && toolCalls.length > 0;
    const hasToolChunks = toolCallChunks && toolCallChunks.length > 0;

    // When tool_calls are present (first delta of a call), they carry the
    // authoritative name + id. Use them to create/update the ToolEvent AND
    // establish the index→id mapping so subsequent chunk-only deltas can find
    // the right event.
    if (hasToolCalls) {
      this.closeText();
      this.closeReasoning();
      toolCalls.forEach((tc, arrayIndex) => {
        const id = (tc.id as string) ?? this.nextId("tc");
        const name = (tc.name as string) ?? "unknown";
        if (name === "task") return;
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
        // (Re)seed the streaming bucket for this call, keyed by id. If a stale
        // bucket exists at this index with a different id (previous call reused
        // the index), overwrite it — the new call takes ownership.
        if (!this.streamingBuckets.has(id)) {
          this.streamingBuckets.set(id, { id, name, argsStr: "" });
        }
        // Update index→id bridge so chunk fragments below can resolve to this id.
        this.indexToBucketId.set(arrayIndex, id);
      });
      // Fall through to toolCallChunks (same delta may carry both).
    }

    if (hasToolChunks) {
      if (!hasToolCalls) {
        this.closeText();
        this.closeReasoning();
      }
      for (const tcc of toolCallChunks) {
        // Normalize the OpenAI `index` to a number (it can arrive as string).
        const rawIdx = tcc.index ?? 0;
        const idx = typeof rawIdx === "number" ? rawIdx : Number(rawIdx);
        // Resolve index → bucket id. The bridge is set when tool_calls arrives
        // (first delta). For chunk-only deltas, the bridge persists from before.
        let bucketId = this.indexToBucketId.get(idx);
        // If this chunk carries an id, it's the first delta — use it directly.
        if (tcc.id) {
          bucketId = tcc.id;
          this.indexToBucketId.set(idx, tcc.id);
        }
        let bucket = bucketId ? this.streamingBuckets.get(bucketId) : undefined;
        if (!bucket) {
          // No prior tool_calls seeded this index (shouldn't normally happen,
          // but handle gracefully): create a new bucket + event.
          const id = tcc.id ?? this.nextId("tcc");
          bucketId = id;
          const name = tcc.name && tcc.name.length > 0 ? tcc.name : "unknown";
          // The `task` tool (subagent delegation) is NOT rendered as a tool
          // row — it is rendered as a SubagentRow. Skip registering it here,
          // mirroring the `hasToolCalls` branch above (which does `if (name ===
          // "task") return;`). Without this, streaming task chunks would create
          // a stray tool row showing the task args.
          if (name === "task") {
            // Still seed the bucket + bridge so later chunks for this call are
            // absorbed (and not mistaken for a new call), but create no event.
            bucket = { id, name, argsStr: "" };
            this.streamingBuckets.set(id, bucket);
            this.indexToBucketId.set(idx, id);
            continue;
          }
          bucket = { id, name, argsStr: "" };
          this.streamingBuckets.set(id, bucket);
          this.indexToBucketId.set(idx, id);
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
        // Update name if this fragment carries it.
        if (tcc.name && tcc.name.length > 0) bucket.name = tcc.name;
        if (tcc.args) bucket.argsStr += tcc.args;
        // Update the ToolEvent in place: name + progressively-parsed args.
        const teIdx = this.toolIndex.get(bucket.id);
        if (teIdx !== undefined) {
          const ev = this.events[teIdx];
          if (ev?.type === "tool") {
            const parsed = parsePartialJson(bucket.argsStr);
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

    if (hasToolCalls) {
      return;
    }

    // --- Orphan subagent tokens (agent_ns set but no tracked SubagentEvent) ---
    // Normally subagent chunks are delegated to the inner accumulator earlier.
    // If we get here, the subagent_started marker was missed — drop the chunk
    // rather than polluting the main timeline with a subagent's internal text.
    if (agentNs) {
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
 * Parse a (possibly partial) JSON object string accumulated from streaming
 * tool-call fragments. Unlike a plain `JSON.parse`, this progressively extracts
 * key/value pairs even when the JSON is still incomplete — so the UI can show
 * e.g. the file_path as soon as its value finishes streaming, instead of
 * waiting for the entire args object to close.
 *
 * Strategy: try `JSON.parse` first (fast path for complete JSON). If that
 * fails, attempt to close the object by appending `}`s and re-parse. If that
 * still fails, do a best-effort regex extraction of completed `"key": "value"`
 * and `"key": <primitive>` pairs. Returns `null` only when nothing useful can
 * be extracted yet (e.g. the string is just `{` or `{"`).
 */
function parsePartialJson(s: string): Record<string, unknown> | null {
  if (!s || !s.trim()) return null;
  // Fast path: complete JSON.
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    /* fall through to progressive extraction */
  }
  const result: Record<string, unknown> = {};
  // Extract completed string key-value pairs: "key": "value"
  // Matches even when the object is still streaming (no closing brace).
  const strRe = /"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(s)) !== null) {
    result[m[1]] = m[3];
  }
  // Extract completed primitive values (number/boolean/null): "key": 42 | true | null
  const primRe = /"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:\s*)(-?\d+(?:\.\d+)?|true|false|null)/g;
  while ((m = primRe.exec(s)) !== null) {
    const key = m[1];
    if (key in result) continue; // string match above takes priority
    const raw = m[3];
    if (raw === "true") result[key] = true;
    else if (raw === "false") result[key] = false;
    else if (raw === "null") result[key] = null;
    else result[key] = Number(raw);
  }
  const final = Object.keys(result).length > 0 ? result : null;
  return final;
}
