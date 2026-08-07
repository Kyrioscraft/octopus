// =============================================================================
// TUI streaming adapter — connects agent stream events to the UI.
// Equivalent to Python tui.textual_adapter.execute_task_textual().
//
// This is the core bridge between the server's NDJSON stream and the Ink
// React component tree. It consumes `StreamEvent`s and calls into UI
// callbacks to render messages, tool calls, approvals, etc.
// =============================================================================

import type { StreamEvent, ChatRequest, ChatMessage, ResumeRequestBody } from "@octopus/tentacle";
import type { TuiClient } from "../client/client.js";
import { getLogger } from "../utils/logging.js";
import type {
  ChatMessageData,
  ToolCallData,
  SessionStats,
  AskUserRequest,
  AskUserWidgetResult,
  SubagentToolExec,
} from "../types.js";
import type { SubagentTracker, MainToolTracker } from "./tool-tracker.js";
import { flushSubagent } from "./tool-tracker.js";
import { processStreamEvent } from "./stream-events.js";

const logger = getLogger("tui.adapter");

// =============================================================================
// UI callbacks — the adapter calls these to update the React state
// =============================================================================

export interface TuiAdapterCallbacks {
  /** Add a message to the chat history. */
  addMessage: (msg: ChatMessageData) => void;
  /** Insert a message before another message by ID. */
  insertMessage: (msg: ChatMessageData, beforeId: string) => void;
  /** Update an existing message by ID (used for streaming assistant output). */
  updateMessage: (id: string, updates: Partial<ChatMessageData>) => void;
  /** Add or update a tool call widget. */
  updateToolCall: (tool: ToolCallData) => void;
  /** Set the spinner/status text. */
  setSpinner: (status: "Thinking" | "Offloading" | null) => void;
  /** Update session token statistics. */
  updateStats: (stats: Partial<SessionStats>) => void;
  /** Called when the server resolves/assigns a thread id (from init event). */
  onThreadResolved: (threadId: string) => void;
  /** Request HITL approval from the user. Returns the decision. */
  requestApproval: (toolName: string, args: Record<string, unknown>) => Promise<"approve" | "reject" | "auto_approve">;
  /** Request ask_user answers from the user. */
  requestAskUser: (questions: AskUserRequest) => Promise<AskUserWidgetResult>;
  /**
   * Called when the server sends `ask_user_question_required` — a HITL
   * interrupt that requires the user to approve/reject one or more tool
   * calls before the agent can proceed. The app shows the ApprovalMenu and
   * calls `resumeAgentTask` once the user decides.
   */
  onApprovalRequired: (questions: unknown[], actionRequests: unknown[]) => void;
  /** Called when the stream is interrupted (HITL break). */
  onInterrupted: (message: string) => void;
  /** Called on stream error. */
  onError: (message: string) => void;
}

// =============================================================================
// Execution context
// =============================================================================

export interface ExecutionContext {
  client: TuiClient;
  callbacks: TuiAdapterCallbacks;
  threadId?: string;
  /** Workspace to bind the thread to (its dir becomes the agent's cwd). */
  workspaceId?: string;
  agentName?: string;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  /** Pre-created assistant message ID to update in-place instead of creating a new one. */
  assistantMessageId?: string;
}

// =============================================================================
// Stream state (mutable per-execution)
// =============================================================================

export interface StreamState {
  assistantMessageId: string | null;
  assistantContent: string;
  reasoningContent: string;
  toolCalls: Map<string, ToolCallData>;
  subagents: Map<string, SubagentTracker>;
  /** Tool executions keyed by toolCallId, for status updates. */
  toolMessages: Map<string, MainToolTracker>;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  startTime: number;
}

// =============================================================================
// executeAgentTask — main entry point
//
// Equivalent to Python execute_task_textual().
// =============================================================================

export async function executeAgentTask(
  ctx: ExecutionContext,
  userMessage: string,
): Promise<void> {
  const state: StreamState = {
    assistantMessageId: ctx.assistantMessageId ?? null,
    assistantContent: "",
    reasoningContent: "",
    toolCalls: new Map(),
    subagents: new Map(),
    toolMessages: new Map(),
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    startTime: Date.now(),
  };

  const { client, callbacks } = ctx;

  callbacks.setSpinner("Thinking");

  try {
    // Build the chat request
    const messages: ChatMessage[] = [
      { role: "user", content: userMessage },
    ];

    const body: ChatRequest = {
      messages,
      thread_id: ctx.threadId,
      workspace_id: ctx.workspaceId,
      // Use "auto" mode to suppress HITL approvals for read tools;
      // destructive shell writes are still blocked by FileEditGuard.
      // file edits (edit_file/write_file) will trigger HITL regardless.
      mode: "auto",
      request_id: `req_${Date.now()}`,
    };

    // Start streaming
    const stream = await client.streamChat(body, {
      signal: ctx.abortSignal,
    });

    // Process stream events
    for await (const event of stream) {
      if (ctx.abortSignal?.aborted) break;

      processStreamEvent(event, state, ctx);
    }

    // Finalize: flush any remaining assistant content
    finalizeStream(state, callbacks);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      // User cancelled — flush what we have
      logger.debug("executeAgentTask aborted by user");
      finalizeStream(state, callbacks);
      callbacks.addMessage({
        id: `app_${Date.now()}`,
        role: "app",
        content: "Generation cancelled.",
        timestamp: Date.now(),
      });
    } else {
      logger.exception("executeAgentTask failed", err);
      callbacks.onError((err as Error).message);
    }
  } finally {
    callbacks.setSpinner(null);
    callbacks.updateStats({
      requestCount: state.requestCount,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      wallTimeSeconds: (Date.now() - state.startTime) / 1000,
    });
  }
}


// =============================================================================
// Finalize the stream — flush any accumulated content
// =============================================================================

function finalizeStream(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
): void {
  // If we have an assistant message (pre-created or stream-created), finalize it.
  if (state.assistantMessageId) {
    callbacks.updateMessage(state.assistantMessageId, {
      content: state.assistantContent,
      metadata: {
        ...(state.reasoningContent ? { reasoning: state.reasoningContent } : {}),
        finalized: true,
      },
    });
  }

  // Output any tools that never got a result.
  for (const tracker of state.toolMessages.values()) {
    if (tracker.status === "running") {
      tracker.status = "done";
      callbacks.updateMessage(tracker.messageId, {
        metadata: {
          toolName: tracker.toolName,
          toolStatus: "done",
          toolArgs: tracker.args,
          ...(tracker.diffStats ? { diffStats: tracker.diffStats } : {}),
        },
      });
    }
  }

  // Finalize all tool calls
  for (const tool of state.toolCalls.values()) {
    callbacks.updateToolCall(tool);
  }

  // Mark any in-flight subagents as done.
  for (const [, tracker] of state.subagents) {
    if (tracker.status === "running") {
      tracker.status = "done";
      flushSubagent(callbacks, tracker);
    }
  }
}
// =============================================================================

export async function resumeAgentTask(
  ctx: ExecutionContext,
  body: ResumeRequestBody,
): Promise<void> {
  if (!ctx.threadId) {
    ctx.callbacks.onError("Cannot resume: no active thread");
    return;
  }

  const state: StreamState = {
    assistantMessageId: null,
    assistantContent: "",
    reasoningContent: "",
    toolCalls: new Map(),
    subagents: new Map(),
    toolMessages: new Map(),
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    startTime: Date.now(),
  };

  ctx.callbacks.setSpinner("Thinking");

  try {
    const stream = await ctx.client.streamResume(ctx.threadId, body, {
      signal: ctx.abortSignal,
    });

    for await (const event of stream) {
      if (ctx.abortSignal?.aborted) break;
      processStreamEvent(event, state, ctx);
    }

    finalizeStream(state, ctx.callbacks);
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      logger.exception("resumeAgentTask failed", err);
      ctx.callbacks.onError((err as Error).message);
    } else {
      logger.debug("resumeAgentTask aborted by user");
    }
  } finally {
    ctx.callbacks.setSpinner(null);
  }
}

