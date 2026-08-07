// =============================================================================
// block-stream.ts — maps server NDJSON StreamEvents to BlockStreamCallbacks.
// Equivalent to the "Block stream" concept in tui-solution.md §3.
//
// This is a new adapter that sits alongside the existing tui-adapter.ts.
// It consumes StreamEvents from the server and drives the BlockStreamCallbacks
// interface, which in turn updates the block-based SessionState in the UI.
//
// The existing tui-adapter.ts (message-based) is kept unchanged — the two
// adapters can coexist while we transition to the block model.
// =============================================================================

import type { StreamEvent } from "@octopus/tentacle";
import type { BlockStreamCallbacks, BlockId } from "../types.js";
import { extractToken } from "./tool-tracker.js";

// =============================================================================
// Per-stream mutable state
// =============================================================================

interface BlockStreamState {
  /** Currently active text block ID, or null if no text is streaming. */
  activeTextId: BlockId | null;
  /** Whether we've started a text block in the current stream. */
  textStarted: boolean;
  /** Currently active thinking block ID, or null if not thinking. */
  activeThinkingId: BlockId | null;
  /** Whether we've started a thinking block in the current stream. */
  thinkingStarted: boolean;
  /** Track which tool_call_ids we've already seen to avoid duplicates. */
  seenToolIds: Set<string>;
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
 * @param stream   - Async generator from `client.streamChat()` / `streamResume()`
 * @param callbacks - Block-level callbacks to drive
 * @param signal   - Optional AbortSignal for cancellation
 */
export async function mapStreamToBlocks(
  stream: AsyncGenerator<StreamEvent>,
  callbacks: BlockStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const state: BlockStreamState = {
    activeTextId: null,
    textStarted: false,
    activeThinkingId: null,
    thinkingStarted: false,
    seenToolIds: new Set(),
  };

  callbacks.onTurnStart();

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;
      processEvent(event, state, callbacks);
    }

    // Finalize any still-active blocks
    finalizeState(state, callbacks);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      finalizeState(state, callbacks);
    } else {
      throw err; // Let the caller handle
    }
  }

  callbacks.onTurnEnd();
}

// =============================================================================
// Event processing
// =============================================================================

function processEvent(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  switch (event.status) {
    case "init":
      // Thread metadata — no block action needed
      break;

    case "loading":
      handleLoading(event, state, callbacks);
      break;

    case "reasoning":
      handleReasoning(event, state, callbacks);
      break;

    case "ask_user_question_required":
      handleConfirm(event, state, callbacks);
      break;

    case "finished":
      // Agent completed — finalize active blocks
      finalizeState(state, callbacks);
      break;

    case "interrupted":
      // HITL interrupt — finalize text but keep confirm pending
      if (state.activeTextId) {
        callbacks.onTextEnd(state.activeTextId);
        state.activeTextId = null;
        state.textStarted = false;
      }
      if (state.activeThinkingId) {
        callbacks.onThinkingEnd(state.activeThinkingId);
        state.activeThinkingId = null;
        state.thinkingStarted = false;
      }
      break;

    case "error":
    case "warning":
      // Errors/warnings don't produce blocks in this model
      break;

    default:
      break;
  }
}

// =============================================================================
// Loading event — handles tokens, tool_calls, subagent messages
// =============================================================================

function handleLoading(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  const msg = (event.msg ?? {}) as Record<string, unknown>;
  const msgType = msg.type as string | undefined;
  const agentNs = msg.agent_ns as string | undefined;

  // --- Subagent messages: skip for now (subagents are rendered via ExploreWidget) ---
  if (agentNs) {
    return;
  }

  // --- Tool calls from main agent ---
  if (msgType === "ai" || msgType === "AIMessage") {
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const tcId = tc.id as string | undefined;
        // Deduplicate by tool_call_id (same tool_call may appear in multiple chunks)
        if (tcId && state.seenToolIds.has(tcId)) continue;
        if (tcId) state.seenToolIds.add(tcId);

        const tcName = (tc.name as string) ?? "unknown";
        const tcArgs = (tc.args ?? {}) as Record<string, unknown>;
        const blockId = createBlockId("tool");
        callbacks.onToolStart(blockId, tcName, tcArgs);
        // TODO: Tool results come as separate "tool" type messages — we'd need to
        // track by tool_call_id and call onToolEnd when the result arrives.
        // For now, mark as done immediately (tool results handled in v2).
        callbacks.onToolEnd(blockId, "", undefined);
      }
      return;
    }
  }

  // --- Tool result messages ---
  if (msgType === "tool") {
    const toolName = (msg.name as string) ?? "";
    const toolContent = (msg.content as string) ?? "";
    // Tool results are currently handled by the tool_call creation above.
    // A richer implementation would match results to earlier onToolStart calls
    // via tool_call_id and call onToolEnd with the actual output.
    return;
  }

  // --- Main agent text tokens ---
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

// =============================================================================
// Reasoning event — thinking block
// =============================================================================

function handleReasoning(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  const msg = (event.msg ?? {}) as Record<string, unknown>;
  const agentNs = msg.agent_ns as string | undefined;

  // Subagent reasoning is skipped (handled by ExploreWidget)
  if (agentNs) return;

  const token = extractToken(event.response);
  if (!token) return;

  if (!state.thinkingStarted) {
    state.activeThinkingId = createBlockId("think");
    state.thinkingStarted = true;
    callbacks.onThinkingStart(state.activeThinkingId);
  }

  // Note: BlockStreamCallbacks doesn't have a "thinking delta" callback.
  // The thinking content is accumulated in the useAgent hook via the
  // textDelta path, or we can extend the callbacks. For now, we track
  // that thinking is running; content accumulation happens in the UI layer.
  // In a richer implementation, we'd add onThinkingDelta to the callbacks.
}

// =============================================================================
// Confirm event — user approval required
// =============================================================================

async function handleConfirm(
  event: StreamEvent,
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): Promise<void> {
  // Finalize any active text before showing confirm
  if (state.activeTextId) {
    callbacks.onTextEnd(state.activeTextId);
    state.activeTextId = null;
    state.textStarted = false;
  }
  if (state.activeThinkingId) {
    callbacks.onThinkingEnd(state.activeThinkingId);
    state.activeThinkingId = null;
    state.thinkingStarted = false;
  }

  // Build the confirm message from action requests
  const interruptMeta = (event.meta?.interrupt ?? {}) as Record<string, unknown>;
  const actionRequests = (interruptMeta.actionRequests as Array<Record<string, unknown>>) ?? [];
  const questions = (event.questions as unknown as Array<Record<string, unknown>>) ?? [];

  // Combine action request names into a display message
  const toolNames = actionRequests
    .map((ar) => ar.name as string)
    .filter(Boolean);
  const message = toolNames.length > 0
    ? `确认执行: ${toolNames.join(", ")} ?`
    : (event.message ?? "需要用户确认");

  const questionText = questions.length > 0
    ? questions.map((q) => q.question ?? q.header ?? "").filter(Boolean).join("; ")
    : "";

  const fullMessage = questionText ? `${message}\n${questionText}` : message;

  const blockId = createBlockId("confirm");
  // onConfirm returns a Promise<boolean> — the UI hook will resolve it
  // when the user presses y/n.
  const approved = await callbacks.onConfirm(blockId, fullMessage);

  // After the promise resolves, the caller (useAgent) updates the block
  // status to approved/rejected, which triggers re-render.
  // We don't call any more callbacks here — the UI state change handles it.
  void approved; // Suppress unused variable warning; the value is used by the caller
}

// =============================================================================
// Finalize — end any still-active blocks
// =============================================================================

function finalizeState(
  state: BlockStreamState,
  callbacks: BlockStreamCallbacks,
): void {
  if (state.activeTextId) {
    callbacks.onTextEnd(state.activeTextId);
    state.activeTextId = null;
    state.textStarted = false;
  }
  if (state.activeThinkingId) {
    callbacks.onThinkingEnd(state.activeThinkingId);
    state.activeThinkingId = null;
    state.thinkingStarted = false;
  }
}
