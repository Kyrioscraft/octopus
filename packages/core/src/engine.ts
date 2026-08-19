/**
 * Agent engine interface + standardized event model.
 *
 * Decouples the server from LangGraph's raw stream format. The server consumes
 * `AsyncIterable<AgentEvent>` instead of poking at LangChain message objects
 * directly — so the transport/serialization layer (chat.service) never touches
 * LangGraph internals.
 *
 * `wrapAgentStream` adapts an existing compiled agent's stream into this shape
 * WITHOUT modifying makeGraph — it's a pure post-processing wrapper. This keeps
 * the "existing code minimally adjusted" constraint intact.
 *
 * Equivalent to a transport-agnostic view of Python `chat_service.py` events.
 */

import type { SubagentRegistryEntry } from "./agent.js";

// =============================================================================
// Standardized event model
// =============================================================================

/**
 * A transport-agnostic agent event (v2 typed protocol). The server assigns
 * per-thread `seq` and serializes these as NDJSON `StreamEvent`s; the client
 * applies targeted patches keyed by the stable ids. No LangChain message dumps
 * are forwarded — everything the UI needs is a typed field.
 *
 * Turn-boundary events (started/finished/error/interrupted) are owned by the
 * chat service layer, NOT emitted here.
 */
export type AgentEvent =
  | { type: "text.delta"; messageId: string; agentNs?: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; agentNs?: string; delta: string }
  | { type: "tool.started"; toolCallId: string; name: string; agentNs?: string }
  | { type: "tool.args.delta"; toolCallId: string; index: number; argsDelta: string }
  | { type: "tool.result"; toolCallId: string; result: string; isError: boolean }
  | {
      type: "subagent.started";
      /** task tool_call_id — stable correlation key across started/finished. */
      callId: string;
      /** Resolved instance key ("tools:<run-id>") when known, else "pending:<callId>". */
      instanceKey: string;
      description: string;
      subagentName: string;
    }
  | { type: "subagent.finished"; instanceKey: string };

/** Input for running a fresh chat turn through the engine wrapper. */
export interface AgentRunInput {
  threadId: string;
  requestId: string;
  /** The compiled agent (from makeGraph). */
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
  langgraphConfig: Record<string, unknown>;
}

// =============================================================================
// AgentEngine interface (capability contract for the server)
// =============================================================================

/**
 * Stable engine contract the server depends on. The current implementation
 * delegates to makeGraph + wrapAgentStream; future runtimes (remote sandbox,
 * multi-model router) can implement this interface without touching the server.
 *
 * NOTE: resolve/stream here are defined for future direct use; the server
 * currently calls makeGraph + wrapAgentStream separately (Phase B wiring).
 * They're provided so the server CAN migrate to engine.stream() incrementally.
 */
export interface AgentEngine {
  /** Stream a fresh turn, yielding standardized events. */
  stream(input: AgentRunInput & { userMessage: string }): AsyncIterable<AgentEvent>;
  /** Stream a HITL resume, yielding standardized events. */
  resume(input: AgentRunInput & { approved: boolean }): AsyncIterable<AgentEvent>;
}

// =============================================================================
// Stream adapter — wraps a raw LangGraph stream into AgentEvent[]
// =============================================================================

/**
 * Unpack a LangGraph v1 stream chunk into the message + stream metadata.
 *
 * In `messages` stream mode, each chunk is `["messages", [message, metadata]]`.
 * The metadata carries two independent subagent indicators:
 *   - `lc_agent_name` — set by the deepagents SDK on every subagent's config
 *     metadata (`lc_agent_name: subagent_type`), propagated verbatim onto each
 *     streamed message's metadata by LangGraph's StreamMessagesHandler. This is
 *     the authoritative, unambiguous subagent identifier.
 *   - `langgraph_checkpoint_ns` / `checkpoint_ns` — a `|`-joined namespace path
 *     whose first segment is the subagent name (e.g. `"Explore"` or
 *     `"Explore:taskId"`). Parsing this is fragile: the segment may or may not
 *     carry a `:` suffix, so a naive `includes(":")` check misses bare names.
 *
 * We return the full metadata object so callers can read either field.
 */
function unpackChunk(chunk: unknown): {
  message: any;
  ns?: string;
  meta?: Record<string, unknown>;
} | null {
  // Multi-mode shape: ["messages", [message, metadata]]
  if (Array.isArray(chunk) && chunk.length === 2 && chunk[0] === "messages") {
    const payload = chunk[1];
    if (Array.isArray(payload) && payload.length >= 1) {
      const message = payload[0];
      const meta = (payload[1] ?? {}) as Record<string, unknown>;
      const ns =
        (meta.langgraph_checkpoint_ns as string | undefined) ??
        (meta.checkpoint_ns as string | undefined);
      return { message, ns, meta };
    }
    const msg = payload ?? null;
    return msg ? { message: msg } : null;
  }
  // Legacy single-mode shape
  if (Array.isArray(chunk) && chunk.length >= 1) {
    return { message: chunk[0] };
  }
  const msg = chunk as any;
  return msg ? { message: msg } : null;
}

/**
 * Structured extraction of a LangChain message's content, covering both the
 * v0 field layout (top-level tool_calls, additional_kwargs.reasoning_content)
 * and the v1 content-blocks layout (content[] entries of type text/reasoning/
 * tool_call/tool_call_chunk).
 *
 * Why this exists: under LangChain v1, streaming chunks carry tool calls as
 * `tool_call_chunk` content blocks (with incremental `args` strings keyed by
 * `index`) and reasoning as `reasoning` content blocks — NOT in the top-level
 * `tool_calls` array or `additional_kwargs`. The old `extractText` only read
 * `type==="text"` blocks, silently dropping reasoning and tool-call info
 * during streaming (they only reappeared after a refresh, once LangGraph had
 * persisted the fully-aggregated message). This function surfaces everything.
 */
interface ExtractedContent {
  /** Concatenated `type:"text"` blocks (or the raw string content). */
  text: string;
  /** Concatenated `type:"reasoning"` blocks. */
  reasoning: string;
  /** Complete tool calls from `type:"tool_call"` content blocks. */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  /** Streaming tool-call fragments from `type:"tool_call_chunk"` content blocks. */
  toolCallChunks: Array<{
    name?: string;
    args?: string;
    index?: string | number;
    id?: string;
  }>;
}

function extractContent(msg: any): ExtractedContent {
  const out: ExtractedContent = { text: "", reasoning: "", toolCalls: [], toolCallChunks: [] };
  const content = msg?.content;

  // String content → text (common for simple providers).
  if (typeof content === "string") {
    out.text = content;
  } else if (Array.isArray(content)) {
    // v1 content-blocks array: dispatch by block.type.
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          if (typeof b.text === "string") textParts.push(b.text);
          break;
        case "reasoning":
          // v1 reasoning content block. Some providers also expose a
          // signature/summary; prefer `reasoning` text.
          if (typeof b.reasoning === "string") reasoningParts.push(b.reasoning);
          break;
        case "tool_call": {
          // Complete tool call embedded as a content block. Skip entries with
          // a missing/empty name — they're streaming artifacts (see
          // normalizeToolCall) and would render as "unknown" on the client.
          const name = typeof b.name === "string" ? b.name : "";
          if (!name) break;
          const args = typeof b.args === "string" ? safeParse(b.args) : (b.args ?? {});
          out.toolCalls.push({ name, args, id: b.id });
          break;
        }
        case "tool_call_chunk": {
          // Streaming fragment: name/args are partial, keyed by `index`.
          out.toolCallChunks.push({
            ...(b.name != null ? { name: b.name } : {}),
            ...(b.args != null ? { args: b.args } : {}),
            ...(b.index != null ? { index: b.index } : {}),
            ...(b.id != null ? { id: b.id } : {}),
          });
          break;
        }
        default:
          // Other block types (image, etc.) are not relevant to the stream UI.
          break;
      }
    }
    out.text = textParts.join("");
    out.reasoning = reasoningParts.join("");
  }

  // v0 / OpenAI compatibility: top-level tool_calls. This array is present on
  // fully-aggregated AI messages (already flattened to {id,name,args} by
  // LangChain's defaultToolCallParser during AIMessage construction), BUT on
  // streaming AIMessageChunks it can carry the raw OpenAI nested shape
  // {id, type:"function", function:{name, arguments}} — which is why the card
  // showed "unknown" during streaming (tc.name was undefined) while history
  // (loaded from the fully-parsed persisted message) was correct.
  // normalizeToolCall() handles both shapes.
  const topToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    ? msg.tool_calls
    : Array.isArray(msg.additional_kwargs?.tool_calls) && msg.additional_kwargs.tool_calls.length > 0
      ? msg.additional_kwargs.tool_calls
      : null;
  if (topToolCalls) {
    for (const tc of topToolCalls) {
      const norm = normalizeToolCall(tc);
      if (!norm) continue;
      if (!out.toolCalls.some((x) => x.id != null && x.id === norm.id)) {
        out.toolCalls.push(norm);
      }
    }
  }

  // Reasoning text: many providers (OpenAI o-series, DeepSeek, Qwen, ...) emit
  // the thinking trace as `additional_kwargs.reasoning_content` as INCREMENTAL
  // per-chunk strings (e.g. "The", " user", " wants"), NOT as content blocks.
  // extractContent must surface this so the engine can route it as a reasoning
  // token — otherwise it gets dropped and thinking only reappears on refresh
  // (when the persisted, fully-concatenated message is loaded).
  const akReasoning = msg.additional_kwargs?.reasoning_content;
  if (typeof akReasoning === "string" && akReasoning.length > 0) {
    out.reasoning = (out.reasoning ? out.reasoning : "") + akReasoning;
  }
  // v0 streaming fragments: top-level tool_call_chunks (AIMessageChunk field).
  if (Array.isArray(msg.tool_call_chunks)) {
    for (const tcc of msg.tool_call_chunks) {
      if (!tcc || typeof tcc !== "object") continue;
      out.toolCallChunks.push({
        ...(tcc.name != null ? { name: tcc.name } : {}),
        ...(tcc.args != null ? { args: tcc.args } : {}),
        ...(tcc.index != null ? { index: tcc.index } : {}),
        ...(tcc.id != null ? { id: tcc.id } : {}),
      });
    }
  }

  return out;
}

/** Parse JSON without throwing; returns {} on failure (used for partial/streaming args). */
function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Normalize a raw tool-call entry into the flat {id, name, args} shape, no
 * matter which wire format it arrives in. This is the streaming equivalent of
 * LangChain's defaultToolCallParser (which only runs when an AIMessage is
 * constructed from additional_kwargs — streaming chunks bypass it). Supports:
 *
 *   - Flat (LangChain normalized):   { id, name, args }
 *   - OpenAI nested (raw streaming): { id, type:"function", function:{ name, arguments } }
 *   - OpenAI nested without wrapper: { id, function:{ name, arguments } }
 *
 * Returns null for entries that have neither a flat `name` nor a nested
 * `function.name`, OR where the name is an empty string. An empty name is
 * significant: under OpenAI's streaming protocol only the *first* delta for a
 * tool call carries `function.name`; subsequent deltas collapse to
 * `{ name: "" }` (LangChain's `collapseToolCallChunks` does `name ?? ""`).
 * If we let the empty-name entry through, the client renders "unknown" for
 * the rest of the stream — the incremental `tool_call_chunks` path is the
 * correct source of truth for streaming args, so we drop the empty-name
 * `tool_calls` entry here and let the chunks accumulate on the client.
 */
function normalizeToolCall(tc: any): { name: string; args: Record<string, unknown>; id?: string } | null {
  if (!tc || typeof tc !== "object") return null;
  // Flat shape (already normalized by LangChain). Reject empty-string names
  // (streaming deltas after the first one carry name: "").
  if (typeof tc.name === "string" && tc.name.length > 0) {
    const args = typeof tc.args === "string" ? safeParse(tc.args) : (tc.args ?? {});
    return { name: tc.name, args, ...(tc.id != null ? { id: tc.id } : {}) };
  }
  // OpenAI nested shape (raw streaming chunk, pre-parser).
  const fn = tc.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string" && fn.name.length > 0) {
    const args =
      typeof fn.arguments === "string" ? safeParse(fn.arguments) : (fn.arguments ?? {});
    return { name: fn.name, args, ...(tc.id != null ? { id: tc.id } : {}) };
  }
  return null;
}

/**
 * Wrap a raw LangGraph agent stream into an async iterable of typed AgentEvents.
 *
 * Translates each graph chunk into zero or more events: text/reasoning deltas,
 * tool lifecycle (started / args.delta / result) keyed by toolCallId, and
 * explicit subagent lifecycle keyed by callId/instanceKey. Does NOT emit
 * turn.started/finished/error — the caller owns those transport-boundary
 * events.
 *
 * GraphInterrupt is swallowed here — the caller checks agent.getState() for
 * pending interrupts, matching the existing pattern.
 */
export async function* wrapAgentStream(
  eventStream: AsyncIterable<unknown>,
  ctx: { subagentRegistry: Map<string, SubagentRegistryEntry> },
): AsyncGenerator<AgentEvent> {
  // ---- per-agent-context state -------------------------------------------
  // A "message" = one AIMessage (many streamed chunks). New AI messages follow
  // a tool result, so the per-context counter increments there. This gives the
  // client a stable messageId to patch against without provider message ids.
  interface AgentCtx {
    messageCounter: number;
    /** tool_call_chunks index → callId bridge (continuation fragments are nameless). */
    indexToId: Map<number, string>;
    /** callIds already announced via tool.started. */
    announced: Set<string>;
    /** callIds whose args were already forwarded as a complete blob. */
    argsFlushed: Set<string>;
  }
  const agentCtxs = new Map<string, AgentCtx>(); // key: agentNs ?? "main"
  const ctxFor = (ns: string | undefined): AgentCtx => {
    const key = ns ?? "main";
    let c = agentCtxs.get(key);
    if (!c) {
      c = { messageCounter: 0, indexToId: new Map(), announced: new Set(), argsFlushed: new Set() };
      agentCtxs.set(key, c);
    }
    return c;
  };
  const messageIdFor = (ns: string | undefined): string => {
    const c = ctxFor(ns);
    return ns ? `${ns}#m${c.messageCounter}` : `main#m${c.messageCounter}`;
  };

  // ---- subagent lifecycle state (same logic as v1, new event shape) -------
  // Track active subagents by the main agent's `task` tool_call_id so we can
  // emit `subagent_finished` when the matching ToolMessage arrives.
  const activeSubagentByCallId = new Map<string, string>(); // callId → placeholder key
  // placeholder key → resolved tools:<run-id> (learned from first internal chunk).
  const placeholderToInstance = new Map<string, string>();
  const instanceToPlaceholder = new Map<string, string>();
  // Instance keys still streaming but not yet finished. The deepagents SDK
  // executes `task` internally and does NOT stream its ToolMessage result back
  // through the main agent's message stream, so the reliable completion signal
  // is "the main agent resumes emitting chunks" — at that point every active
  // instance has returned, because `task` blocks until its subagent finishes.
  const activeInstances = new Set<string>();
  // `task` args accumulation (streamed in fragments; the complete tool_calls
  // array carries `args: {}` during streaming). Keyed by callId.
  const taskArgsBuf = new Map<string, string>();
  const taskIndexToId = new Map<number, string>();
  const taskStarted = new Set<string>();

  for await (const chunk of eventStream) {
    const unpacked = unpackChunk(chunk);
    if (!unpacked) continue;
    const { message: msg, ns, meta } = unpacked;
    const type = msg._getType?.() ?? msg.type ?? "";
    if (type === "human" || type === "user") continue;

    const { text, reasoning, toolCalls, toolCallChunks } = extractContent(msg);

    // Resolve subagent identity: require BOTH a leading `tools:` ns segment AND
    // metadata.lc_agent_name (set only by the deepagents SDK on subgraph
    // chunks). A bare `tools:` ns is the MAIN agent's own tool namespace.
    const lcAgentName = meta?.lc_agent_name as string | undefined;
    let agentNs: string | undefined;
    if (ns) {
      const firstSeg = ns.split("|")[0];
      if (firstSeg.startsWith("tools:") && lcAgentName) {
        agentNs = firstSeg; // unique per-invocation instance key
        // FIFO-bind the instance key to its pending placeholder.
        if (!instanceToPlaceholder.has(agentNs)) {
          for (const [callId, placeholder] of activeSubagentByCallId) {
            if (!placeholderToInstance.has(placeholder)) {
              placeholderToInstance.set(placeholder, agentNs);
              instanceToPlaceholder.set(agentNs, placeholder);
              activeInstances.add(agentNs);
              break;
            }
          }
        }
      }
    }
    const ac = ctxFor(agentNs);

    // ---- main-agent task calls → subagent lifecycle -----------------------
    if (!agentNs && type === "ai") {
      // Seed the index→id bridge from complete tool_calls entries.
      const allCalls =
        toolCalls.length > 0
          ? toolCalls
          : ((msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? []);
      for (let i = 0; i < allCalls.length; i++) {
        const tc = allCalls[i];
        if (tc?.name === "task" && typeof tc.id === "string" && tc.id) {
          taskIndexToId.set(i, tc.id);
        }
      }
      // Accumulate task args fragments.
      for (let i = 0; i < toolCallChunks.length; i++) {
        const tcc = toolCallChunks[i];
        if (!tcc || tcc.name !== "task") {
          const idx = typeof tcc?.index === "number" ? tcc.index : Number(tcc?.index);
          if (!taskIndexToId.has(Number.isNaN(idx) ? i : idx)) continue;
        }
        if (typeof tcc.args !== "string" || tcc.args.length === 0) continue;
        const idx = typeof tcc.index === "number" ? tcc.index : Number(tcc.index);
        const callId =
          (typeof tcc.id === "string" && tcc.id ? tcc.id : undefined) ??
          taskIndexToId.get(Number.isNaN(idx) ? i : idx);
        if (!callId) continue;
        taskIndexToId.set(Number.isNaN(idx) ? i : idx, callId);
        taskArgsBuf.set(callId, (taskArgsBuf.get(callId) ?? "") + tcc.args);
      }
      // Emit subagent.started once the args JSON looks complete.
      for (const [callId, argsStr] of taskArgsBuf) {
        if (taskStarted.has(callId)) continue;
        if (!argsStr.trimEnd().endsWith("}")) continue;
        const parsed = safeParse(argsStr);
        const saType = (parsed.subagent_type as string) ?? "general-purpose";
        const description = typeof parsed.description === "string" ? parsed.description : "";
        taskStarted.add(callId);
        const placeholderKey = `pending:${callId}`;
        activeSubagentByCallId.set(callId, placeholderKey);
        yield {
          type: "subagent.started",
          callId,
          instanceKey: placeholderKey,
          description,
          subagentName: saType,
        };
      }
    }

    // ---- subagent.finished -------------------------------------------------
    if (type === "tool" && msg.tool_call_id) {
      const finishedNs = activeSubagentByCallId.get(msg.tool_call_id);
      if (finishedNs) {
        activeSubagentByCallId.delete(msg.tool_call_id);
        // Resolve placeholder → real instance key; fallback if the subagent
        // never streamed an internal chunk.
        const instanceKey = placeholderToInstance.get(finishedNs) ?? finishedNs;
        activeInstances.delete(instanceKey);
        yield { type: "subagent.finished", instanceKey };
      }
    }
    if (!agentNs && activeInstances.size > 0) {
      // Main agent resumed ⇒ every still-active subagent has returned.
      for (const instanceKey of activeInstances) {
        yield { type: "subagent.finished", instanceKey };
      }
      activeInstances.clear();
    }

    // ---- tool lifecycle (all tools except `task`, which renders as a
    //      SubagentRow, not a tool row) --------------------------------------
    if (type === "tool" && msg.tool_call_id) {
      const callId = msg.tool_call_id as string;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
                .join("")
            : "";
      const isError = msg.status === "error" || (typeof msg.status?.error === "string" && !!msg.status.error);
      yield { type: "tool.result", toolCallId: callId, result: content, isError };
      // A tool result closes the current AI message; the next AI chunk starts
      // a new message in this agent context.
      ac.messageCounter++;
      ac.indexToId.clear();
      continue;
    }

    if (type === "ai") {
      // Complete tool_calls entries (from content blocks or top-level): emit
      // tool.started once per callId, and flush complete args as one delta
      // when nothing was streamed before (non-streaming providers).
      for (const tc of toolCalls) {
        if (!tc.id || !tc.name || tc.name === "task") continue;
        if (!ac.announced.has(tc.id)) {
          ac.announced.add(tc.id);
          yield { type: "tool.started", toolCallId: tc.id, name: tc.name, ...(agentNs ? { agentNs } : {}) };
        }
        if (!ac.argsFlushed.has(tc.id) && tc.args && Object.keys(tc.args).length > 0) {
          ac.argsFlushed.add(tc.id);
          yield {
            type: "tool.args.delta",
            toolCallId: tc.id,
            index: 0,
            argsDelta: JSON.stringify(tc.args),
          };
        }
      }
      // Streaming fragments: bridge index→callId, emit started on first sight
      // of (id, name), and forward each args fragment verbatim.
      for (let i = 0; i < toolCallChunks.length; i++) {
        const tcc = toolCallChunks[i];
        if (!tcc) continue;
        const idxRaw = typeof tcc.index === "number" ? tcc.index : Number(tcc.index);
        const idx = Number.isNaN(idxRaw) ? i : idxRaw;
        if (typeof tcc.id === "string" && tcc.id) {
          ac.indexToId.set(idx, tcc.id);
        }
        const callId =
          (typeof tcc.id === "string" && tcc.id ? tcc.id : undefined) ?? ac.indexToId.get(idx);
        if (!callId) continue;
        const name = typeof tcc.name === "string" && tcc.name.length > 0 ? tcc.name : undefined;
        if (name && name !== "task") {
          if (!ac.announced.has(callId)) {
            ac.announced.add(callId);
            yield { type: "tool.started", toolCallId: callId, name, ...(agentNs ? { agentNs } : {}) };
          }
          if (typeof tcc.args === "string" && tcc.args.length > 0) {
            yield { type: "tool.args.delta", toolCallId: callId, index: idx, argsDelta: tcc.args };
          }
        }
      }
    }

    // ---- content deltas ----------------------------------------------------
    const messageId = messageIdFor(agentNs);
    if (reasoning.length > 0) {
      yield { type: "reasoning.delta", messageId, ...(agentNs ? { agentNs } : {}), delta: reasoning };
    }
    if (text.length > 0) {
      yield { type: "text.delta", messageId, ...(agentNs ? { agentNs } : {}), delta: text };
    }
  }
}
