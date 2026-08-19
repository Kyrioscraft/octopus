// =============================================================================
// block-stream.ts — maps server NDJSON StreamEvents to BlockStreamCallbacks.
// Equivalent to the "Block stream" concept in architecture/tui-solution.md §3.
//
// Returns an InterruptContext when the server pauses for user input (HITL),
// so the caller can resume the stream after the user responds.
// =============================================================================

import type { StreamEvent } from "@octopus/tentacle";
import type { BlockStreamCallbacks, BlockId, TodoItem } from "../types.js";


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
// v2 typed protocol: discriminate on `type` (the legacy `status`-based
// chunks no longer exist on the server).
// =============================================================================

function processEvent(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): InterruptContext | null {
  switch (event.type) {
    case "turn.started":
      state.threadId = event.threadId ?? state.threadId;
      break;

    case "text.delta":
    case "text.ended": {
      if (event.agentNs) break; // subagent text — rendered by its own widget
      const delta = event.type === "text.delta" ? event.delta : null;
      if (delta) {
        if (!state.textStarted) {
          state.activeTextId = createBlockId("text");
          state.textStarted = true;
          callbacks.onTextStart(state.activeTextId);
        }
        if (state.activeTextId) {
          callbacks.onTextDelta(state.activeTextId, delta);
        }
      }
      break;
    }

    case "reasoning.delta":
    case "reasoning.ended": {
      if (event.agentNs) break;
      if (!state.thinkingStarted) {
        state.activeThinkingId = createBlockId("think");
        state.thinkingStarted = true;
        state.thinkingContent = "";
        callbacks.onThinkingStart(state.activeThinkingId);
      }
      // Accumulate thinking content — passed to onThinkingEnd on finalization.
      // Terminal events replace the accumulated value (authoritative full text).
      if (event.type === "reasoning.delta") {
        state.thinkingContent += event.delta;
      } else {
        state.thinkingContent = event.text;
      }
      break;
    }

    case "tool.started": {
      if (event.agentNs) break; // subagent tools
      const tcName = event.name;
      const tcId = event.toolCallId;

      const dedupKey = tcId;
      if (state.seenToolIds.has(dedupKey)) break;
      state.seenToolIds.add(dedupKey);

      // write_todos → todo panel, not a tool block
      if (tcName === "write_todos") break;
      // ask_user_question → surfaced via the ask panel, not a tool row
      if (tcName === "ask_user_question") break;

      const blockId = createBlockId("tool");
      // First tool → running; rest → pending (sequential execution)
      if (state.toolBlockMap.size === 0 && state.pendingToolCalls.length === 0) {
        callbacks.onToolStart(blockId, tcName, {});
      } else {
        state.pendingToolCalls.push({ blockId, toolName: tcName, tcId });
        callbacks.onToolPending(blockId, tcName, {});
      }
      state.toolBlockMap.set(tcId, { blockId, toolName: tcName });
      break;
    }

    case "tool.result": {
      if (event.agentNs) break;
      const tcId = event.toolCallId;
      const entry = tcId ? state.toolBlockMap.get(tcId) : undefined;
      if (!entry) break;
      state.toolBlockMap.delete(tcId!);
      callbacks.onToolEnd(
        entry.blockId,
        event.isError ? "" : event.result,
        event.isError ? (event.result || "Tool execution failed") : undefined,
      );
      promoteNextTool(state, callbacks);
      break;
    }

    case "ask":
      return handleInterrupt(event, state, callbacks);

    case "turn.finished":
      // Stream completed — finalize everything including tools
      finalizeState(state, callbacks, true);
      break;

    case "turn.interrupted":
      // HITL interrupt — finalize text/thinking but not tools (results arrive
      // after resume).
      if (state.activeTextId) {
        callbacks.onTextEnd(state.activeTextId);
        state.activeTextId = null;
        state.textStarted = false;
      }
      if (state.activeThinkingId) {
        finalizeThinking(state, callbacks);
      }
      break;

    case "turn.error":
      finalizeState(state, callbacks, true);
      break;

    case "subagent.started":
    case "subagent.finished":
    case "tool.args.delta":
    case "heartbeat":
    case "idle":
      // Not rendered at block level (subagent widgets / keepalive / replay EOF)
      break;
  }

  return null;
}

// =============================================================================
// Interrupt handling — returns InterruptContext for the caller
// v2 `ask` event: kind + questions[].actionRequests distinguish
// tool-approval confirms from ask_user_question panels.
// =============================================================================

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

function handleInterrupt(
  event: Extract<StreamEvent, { type: "ask" }>,
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
  if (event.threadId) state.threadId = event.threadId;
  else if (event.thread_id) state.threadId = event.thread_id;

  // Tool approval → confirm; discussion/clarify → ask_user panel.
  if (event.kind === "tool_approval" || event.kind === "plan_approval") {
    const actionRequests = event.questions
      .map((q) => q.context?.actionRequests)
      .filter((a): a is NonNullable<typeof a> => !!a)
      .flat();
    if (actionRequests.length > 0) {
      const toolNames = actionRequests.map((ar) => ar.name).filter(Boolean);
      const message = toolNames.length > 0
        ? `${toolNames.join(", ")} 确认执行?`
        : "需要用户确认";

      const blockId = createBlockId("confirm");
      const confirmPromise = callbacks.onConfirm(blockId, message);

      return {
        kind: "confirm",
        confirmPromise,
        actionRequests: actionRequests.map((ar) => ({
          name: ar.name ?? "unknown",
          args: (ar.args ?? {}) as Record<string, unknown>,
        })),
        threadId: state.threadId,
      };
    }
  }

  if (event.questions.length > 0) {
    return {
      kind: "ask_user",
      questions: event.questions as unknown as Array<Record<string, unknown>>,
      threadId: state.threadId,
    };
  }

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
