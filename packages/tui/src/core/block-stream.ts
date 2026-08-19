// =============================================================================
// block-stream.ts — maps server NDJSON StreamEvents to BlockStreamCallbacks.
// Equivalent to the "Block stream" concept in architecture/tui-solution.md §3.
//
// Returns an InterruptContext when the server pauses for user input (HITL),
// so the caller can resume the stream after the user responds.
// =============================================================================

import type { StreamEvent } from "@octopus/tentacle";
import type { BlockStreamCallbacks, BlockId, TodoItem } from "../types.js";
import { extractToken } from "./tool-tracker.js";

// =============================================================================
// Interrupt context — returned when the server pauses for user input
// =============================================================================

export type InterruptKind = "confirm" | "ask_user";

export interface ConfirmInterrupt {
  kind: "confirm";
  /** Promise that resolves when the user presses y/n. */
  confirmPromise: Promise<boolean>;
  /** Tool names requiring approval (for display). */
  actionRequests: Array<{ name: string; args: Record<string, unknown> }>;
  /** Thread ID for resume. */
  threadId: string | null;
}

export interface AskUserInterrupt {
  kind: "ask_user";
  /** Questions from the server. */
  questions: Array<Record<string, unknown>>;
  /** Thread ID for resume. */
  threadId: string | null;
}

export type InterruptContext = ConfirmInterrupt | AskUserInterrupt;

// =============================================================================
// Per-stream mutable state
// =============================================================================

interface BlockStreamState {
  activeTextId: BlockId | null;
  textStarted: boolean;
  activeThinkingId: BlockId | null;
  thinkingStarted: boolean;
  /** Accumulated thinking content for the current thinking block. */
  thinkingContent: string;
  seenToolIds: Set<string>;
  /** Map from tool_call_id to { blockId, toolName } for matching results to calls. */
  toolBlockMap: Map<string, { blockId: BlockId; toolName: string }>;
  /** Pending tool calls waiting for their turn (sequential execution). */
  pendingToolCalls: Array<{ blockId: BlockId; toolName: string; tcId?: string }>;
  /** Thread ID resolved from the "init" event. */
  threadId: string | null;
}

function createBlockId(prefix: string): BlockId {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Consume an async generator of StreamEvents and drive the provided
 * BlockStreamCallbacks.
 *
 * Returns an InterruptContext if the server paused for user input.
 * The caller should handle the interrupt and then optionally call
 * mapStreamToBlocks again with the resumed stream.
 */
export async function mapStreamToBlocks(
  stream: AsyncGenerator<StreamEvent>,
  callbacks: BlockStreamCallbacks,
  signal?: AbortSignal,
): Promise<InterruptContext | null> {
  const state: BlockStreamState = {
    activeTextId: null,
    textStarted: false,
    activeThinkingId: null,
    thinkingStarted: false,
    thinkingContent: "",
    seenToolIds: new Set(),
    toolBlockMap: new Map(),
    pendingToolCalls: [],
    threadId: null,
  };

  callbacks.onTurnStart();

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      const interrupt = processEvent(event, state, callbacks);
      if (interrupt) {
        // Interrupted — finalize text/thinking but NOT tools (they'll get results after resume)
        finalizeState(state, callbacks, false);
        callbacks.onTurnEnd();
        return interrupt;
      }
    }

    // Normal completion — finalize everything including tools
    finalizeState(state, callbacks, true);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      finalizeState(state, callbacks, true);
      callbacks.onTurnEnd();
    }
    finalizeState(state, callbacks, true);
    if ((err as Error).name !== "AbortError") {
      throw err;
    }
  }

  callbacks.onTurnEnd();
  return null;
}

// =============================================================================
// Event processing — returns InterruptContext if server paused
// =============================================================================

function processEvent(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): InterruptContext | null {
  switch (event.status) {
    case "init":
      if (event.meta?.thread_id) {
        state.threadId = event.meta.thread_id as string;
      }
      break;

    case "loading":
      handleLoading(event, state, callbacks);
      break;

    case "reasoning":
      handleReasoning(event, state, callbacks);
      break;

    case "ask_user_question_required":
      return handleInterrupt(event, state, callbacks);

    case "finished":
      // Stream completed — finalize everything including tools
      finalizeState(state, callbacks, true);
      break;

    case "interrupted":
      // HITL interrupt — finalize text/thinking but don't create confirm yet
      if (state.activeTextId) {
        callbacks.onTextEnd(state.activeTextId);
        state.activeTextId = null;
        state.textStarted = false;
      }
      if (state.activeThinkingId) {
        finalizeThinking(state, callbacks);
      }
      break;

    case "error":
    case "warning":
      break;

    default:
      break;
  }

  return null;
}

// =============================================================================
// Loading event — tokens, tool_calls, tool results
// =============================================================================

function handleLoading(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  const msg = (event.msg ?? {}) as Record<string, unknown>;
  const msgType = msg.type as string | undefined;
  const agentNs = msg.agent_ns as string | undefined;

  // Subagent messages: skip (rendered via ExploreWidget in legacy mode)
  if (agentNs) return;

  // ── Tool calls from main agent (AI message with tool_calls / tool_call_chunks) ──
  if (msgType === "ai" || msgType === "AIMessage") {
    // LangChain sends tool_calls (complete) or tool_call_chunks (streaming incremental)
    const toolCalls = (msg.tool_calls ?? msg.tool_call_chunks) as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      for (let ti = 0; ti < toolCalls.length; ti++) {
        const tc = toolCalls[ti]!;
        const tcId = (tc.id as string) || undefined;
        const tcName = (tc.name as string) || undefined;
        const tcIndex = tc.index as number | undefined;

        if (!tcName) continue;

        const dedupKey = tcId ?? (tcIndex !== undefined ? `idx_${tcIndex}` : `${tcName}:${JSON.stringify(tc.args ?? {})}`);
        if (state.seenToolIds.has(dedupKey)) continue;
        state.seenToolIds.add(dedupKey);

        // ── write_todos: route to todo panel, not as tool block ──
        if (tcName === "write_todos") {
          const todos = (tc.args as Record<string, unknown>)?.todos;
          if (Array.isArray(todos)) {
            callbacks.onTodosUpdate(todos as unknown as TodoItem[]);
          }
          continue;
        }

        // ── ask_user_question: don't create a visible tool block; the
        //    questions are surfaced directly via the AskUserMenu panel
        //    (handled by handleInterrupt on the ask_user_question_required
        //    event). Skipping here prevents the noisy "ask_user_question"
        //    row from appearing in the conversation stream. ──
        if (tcName === "ask_user_question") {
          continue;
        }

        const tcArgs = (tc.args ?? {}) as Record<string, unknown>;
        const blockId = createBlockId("tool");

        // First tool → running; rest → pending (sequential)
        if (ti === 0 && state.pendingToolCalls.length === 0) {
          callbacks.onToolStart(blockId, tcName, tcArgs);
        } else {
          state.pendingToolCalls.push({ blockId, toolName: tcName, tcId });
          callbacks.onToolPending(blockId, tcName, tcArgs);
        }

        const key = tcId ?? (tcIndex !== undefined ? `idx_${tcIndex}` : undefined);
        if (key) {
          state.toolBlockMap.set(key, { blockId, toolName: tcName });
        }
      }
      return;
    }
  }

  // ── Tool result messages — update the matching block ──
  if (msgType === "tool") {
    const tcId = msg.tool_call_id as string | undefined;
    const toolContent = (msg.content as string) ?? "";
    const toolName = (msg.name as string) ?? "";
    const isError = !!(msg as Record<string, unknown>).is_error;

    // Match by tool_call_id first (exact)
    if (tcId && state.toolBlockMap.has(tcId)) {
      const entry = state.toolBlockMap.get(tcId)!;
      state.toolBlockMap.delete(tcId);
      callbacks.onToolEnd(
        entry.blockId,
        isError ? "" : toolContent,
        isError ? (toolContent || "Tool execution failed") : undefined,
      );
      // Promote next pending tool to running
      promoteNextTool(state, callbacks);
      return;
    }

    // Fallback: match by tool name (only if exactly one running tool with that name)
    if (toolName) {
      const matchedEntry = findRunningToolBlock(state, toolName);
      if (matchedEntry) {
        callbacks.onToolEnd(
          matchedEntry.blockId,
          isError ? "" : toolContent,
          isError ? (toolContent || "Tool execution failed") : undefined,
        );
        promoteNextTool(state, callbacks);
        return;
      }
    }
    return;
  }

  // ── Main agent text tokens ──
  const token = extractToken(event.response);
  if (token) {
    if (!state.textStarted) {
      state.activeTextId = createBlockId("text");
      state.textStarted = true;
      callbacks.onTextStart(state.activeTextId);
    }
    if (state.activeTextId) {
      callbacks.onTextDelta(state.activeTextId, token);
    }
  }
}

/**
 * Find a running tool block by name (fallback when tool_call_id doesn't match).
 * Returns the first matching entry, or undefined if none found.
 */
function findRunningToolBlock(
  state: BlockStreamState,
  toolName: string,
): { blockId: BlockId; toolName: string } | undefined {
  for (const [tcId, entry] of state.toolBlockMap) {
    if (entry.toolName === toolName) {
      state.toolBlockMap.delete(tcId);
      return entry;
    }
  }
  return undefined;
}

// =============================================================================
// Reasoning event — thinking block with content accumulation
// =============================================================================

function handleReasoning(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  const msg = (event.msg ?? {}) as Record<string, unknown>;
  const agentNs = msg.agent_ns as string | undefined;

  if (agentNs) return;

  const token = extractToken(event.response);
  if (!token) return;

  if (!state.thinkingStarted) {
    state.activeThinkingId = createBlockId("think");
    state.thinkingStarted = true;
    state.thinkingContent = "";
    callbacks.onThinkingStart(state.activeThinkingId);
  }

  // Accumulate thinking content — passed to onThinkingEnd on finalization
  state.thinkingContent += token;
}

/**
 * Promote the next pending tool to running.
 */
function promoteNextTool(
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  const next = state.pendingToolCalls.shift();
  if (next) {
    callbacks.onToolPromote(next.blockId);
  }
}

// =============================================================================
// Interrupt handling — returns InterruptContext for the caller
// =============================================================================

function handleInterrupt(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): InterruptContext | null {
  // Finalize active text / thinking before showing interrupt UI
  if (state.activeTextId) {
    callbacks.onTextEnd(state.activeTextId);
    state.activeTextId = null;
    state.textStarted = false;
  }
  if (state.activeThinkingId) {
    finalizeThinking(state, callbacks);
  }

  const interruptMeta = (event.meta?.interrupt ?? {}) as Record<string, unknown>;
  const actionRequests = (interruptMeta.actionRequests as Array<Record<string, unknown>>) ?? [];
  const questions = (event.questions as unknown as Array<Record<string, unknown>>) ?? [];

  // Distinguish: action requests → confirm; questions → ask_user
  if (actionRequests.length > 0) {
    // ── Tool approval confirm ──
    const toolNames = actionRequests.map((ar) => ar.name as string).filter(Boolean);
    const message = toolNames.length > 0
      ? `${toolNames.join(", ")} 确认执行?`
      : (event.message ?? "需要用户确认");

    const blockId = createBlockId("confirm");
    const confirmPromise = callbacks.onConfirm(blockId, message);

    return {
      kind: "confirm",
      confirmPromise,
      actionRequests: actionRequests.map((ar) => ({
        name: (ar.name as string) ?? "unknown",
        args: (ar.args ?? {}) as Record<string, unknown>,
      })),
      threadId: state.threadId,
    };
  }

  if (questions.length > 0) {
    // ── Ask user questions ──
    return {
      kind: "ask_user",
      questions,
      threadId: state.threadId,
    };
  }

  // Neither actionRequests nor questions — nothing to do
  return null;
}

// =============================================================================
// Finalize — end any still-active blocks
// =============================================================================

function finalizeState(
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
  finalizeTools: boolean,
): void {
  // Finalize thinking first (may have accumulated content)
  if (state.activeThinkingId) {
    finalizeThinking(state, callbacks);
  }

  if (state.activeTextId) {
    callbacks.onTextEnd(state.activeTextId);
    state.activeTextId = null;
    state.textStarted = false;
  }

  // Tools: only finalize on stream-end (not interrupt).
  // During interrupt, tools like ask_user_question haven't received
  // their result yet — it arrives after the user responds and the
  // stream resumes.
  if (finalizeTools) {
    for (const [tcId, entry] of state.toolBlockMap) {
      callbacks.onToolEnd(entry.blockId, "", undefined);
      state.toolBlockMap.delete(tcId);
    }
  }
}

/**
 * Finalize the thinking block with accumulated content.
 */
function finalizeThinking(
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  if (!state.activeThinkingId) return;
  callbacks.onThinkingEnd(
    state.activeThinkingId,
    state.thinkingContent || undefined,
  );
  state.activeThinkingId = null;
  state.thinkingStarted = false;
  state.thinkingContent = "";
}
