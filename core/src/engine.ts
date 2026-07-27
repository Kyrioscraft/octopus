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
 * A transport-agnostic agent event. The server serializes these into NDJSON;
 * tui parses them the same way. Neither side imports LangGraph types.
 *
 * Design: one variant per kind of thing that can happen during a turn. The
 * `msg` raw dump is included on token/tool variants so clients that want the
 * full LangChain message (e.g. for tool-call rendering) can still get it, but
 * the common fields are promoted to typed top-level keys.
 */
export type AgentEvent =
  | { type: "init"; requestId: string; threadId: string }
  | {
      type: "token";
      text: string;
      isReasoning: boolean;
      /** Originating subagent type, when the message came from a subagent. */
      agentNs?: string;
      /** Raw LangChain message dump (content, tool_calls, tool_call_id, ...). */
      msg?: Record<string, unknown>;
      requestId?: string;
    }
  | {
      type: "subagent_started";
      agentNs: string;
      description: string;
      systemPrompt: string;
      requestId?: string;
    }
  | { type: "finished"; threadId: string; title?: string }
  | { type: "error"; errorType: string; message: string; threadId?: string };

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

/** Unpack a LangGraph v1 stream chunk into the message + stream metadata. */
function unpackChunk(chunk: unknown): {
  message: any;
  ns?: string;
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
      return { message, ns };
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
          // Complete tool call embedded as a content block.
          const args = typeof b.args === "string" ? safeParse(b.args) : (b.args ?? {});
          out.toolCalls.push({ name: b.name ?? "unknown", args, id: b.id });
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
 * `function.name` (e.g. malformed/partial chunks).
 */
function normalizeToolCall(tc: any): { name: string; args: Record<string, unknown>; id?: string } | null {
  if (!tc || typeof tc !== "object") return null;
  // Flat shape (already normalized by LangChain).
  if (typeof tc.name === "string") {
    const args = typeof tc.args === "string" ? safeParse(tc.args) : (tc.args ?? {});
    return { name: tc.name, args, ...(tc.id != null ? { id: tc.id } : {}) };
  }
  // OpenAI nested shape (raw streaming chunk, pre-parser).
  const fn = tc.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string") {
    const args =
      typeof fn.arguments === "string" ? safeParse(fn.arguments) : (fn.arguments ?? {});
    return { name: fn.name, args, ...(tc.id != null ? { id: tc.id } : {}) };
  }
  return null;
}

/**
 * Wrap a raw LangGraph agent stream into an async iterable of AgentEvent.
 *
 * Translates each graph chunk into zero or more AgentEvents (token /
 * subagent_started). Does NOT emit init/finished/error — the caller owns those
 * (they're transport-level boundary events). This keeps the adapter focused on
 * "what the model/tool produced", while the service decides when a turn starts
 * and ends.
 *
 * GraphInterrupt is swallowed here (re-exports nothing) — the caller checks
 * agent.getState() for pending interrupts, matching the existing pattern.
 */
export async function* wrapAgentStream(
  eventStream: AsyncIterable<unknown>,
  ctx: { requestId: string; subagentRegistry: Map<string, SubagentRegistryEntry> },
): AsyncGenerator<AgentEvent> {
  for await (const chunk of eventStream) {
    const unpacked = unpackChunk(chunk);
    if (!unpacked) continue;
    const { message: msg, ns } = unpacked;
    const type = msg._getType?.() ?? msg.type ?? "";
    if (type === "human" || type === "user") continue;

    const { text, reasoning, toolCalls, toolCallChunks } = extractContent(msg);
    const hasTopLevelToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasTopLevelChunks = Array.isArray(msg.tool_call_chunks) && msg.tool_call_chunks.length > 0;
    const hasAnyToolCalls =
      toolCalls.length > 0 || toolCallChunks.length > 0 || hasTopLevelToolCalls || hasTopLevelChunks;
    // Reasoning is present either as v1 content blocks or v0 additional_kwargs.
    const isReasoning =
      reasoning.length > 0 || msg.additional_kwargs?.reasoning_content != null;

    if (!text && !reasoning && !hasAnyToolCalls && type !== "tool") continue;

    // Resolve subagent namespace.
    const nsHasColon = ns?.includes(":") ?? false;
    const nsPrefix = nsHasColon ? (ns!.split(":")[0]) : "";
    const agentNs = nsHasColon && ctx.subagentRegistry.has(nsPrefix) ? nsPrefix : undefined;

    // Emit subagent_started when the main agent invokes the `task` tool.
    // Check both content-block tool_calls and the top-level array.
    if (!agentNs && type === "ai") {
      const allCalls = toolCalls.length > 0 ? toolCalls : (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
      for (const tc of allCalls) {
        if (tc.name === "task") {
          const tcArgs = (tc.args ?? {}) as Record<string, unknown>;
          const saType = (tcArgs.subagent_type as string) ?? "general-purpose";
          const entry = ctx.subagentRegistry.get(saType);
          yield {
            type: "subagent_started",
            agentNs: saType,
            description: (tcArgs.description as string) ?? "",
            systemPrompt: entry?.systemPrompt ?? "",
            requestId: ctx.requestId,
          };
        }
      }
    }

    // Build the msg payload forwarded to the client. Carry whichever tool-call
    // representation is present so the client can render streaming fragments
    // (tool_call_chunks) and complete calls (tool_calls) uniformly.
    const msgPayload: Record<string, unknown> = { type };
    if (agentNs) msgPayload.agent_ns = agentNs;
    // Prefer the structured toolCalls from content blocks; fall back to the
    // raw top-level array for providers that populate it directly.
    if (toolCalls.length > 0) {
      msgPayload.tool_calls = toolCalls;
    } else if (hasTopLevelToolCalls) {
      msgPayload.tool_calls = msg.tool_calls;
    }
    if (toolCallChunks.length > 0) {
      msgPayload.tool_call_chunks = toolCallChunks;
    } else if (hasTopLevelChunks) {
      msgPayload.tool_call_chunks = msg.tool_call_chunks;
    }
    if (msg.tool_call_id) msgPayload.tool_call_id = msg.tool_call_id;
    if (msg.name) msgPayload.name = msg.name;

    yield {
      type: "token",
      // Surface reasoning text when present so the client can render thinking
      // live (previously reasoning blocks were dropped by extractText).
      text: isReasoning ? reasoning : text,
      isReasoning,
      ...(agentNs ? { agentNs } : {}),
      msg: msgPayload,
      requestId: ctx.requestId,
    };
  }
}
