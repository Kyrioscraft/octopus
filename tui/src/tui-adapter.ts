// =============================================================================
// TUI streaming adapter — connects agent stream events to the UI.
// Equivalent to Python tui.textual_adapter.execute_task_textual().
//
// This is the core bridge between the server's NDJSON stream and the Ink
// React component tree. It consumes `StreamEvent`s and calls into UI
// callbacks to render messages, tool calls, approvals, etc.
// =============================================================================

import type { StreamEvent, ChatRequest, ChatMessage, ResumeRequestBody } from "@octopus/tentacle";
import type { TuiClient } from "./client.js";
import { getLogger } from "./logging.js";
import type {
  ChatMessageData,
  ToolCallData,
  SessionStats,
  AskUserRequest,
  AskUserWidgetResult,
  SubagentToolExec,
} from "./types.js";

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

/**
 * Tracks one subagent invocation as it streams. Keyed by `agentNs` (the
 * subagent type, e.g. "general-purpose") in `StreamState.subagents`.
 *
 * Also reused for `StreamState.mainExplore` — a synthetic tracker that
 * aggregates the main agent's own exploration tool calls (read_file,
 * list_directory, grep, …) into a single Explore widget.
 */
interface SubagentTracker {
  /** The TUI message id for this subagent's Explore widget. */
  messageId: string;
  agentType: string;
  description: string;
  systemPrompt?: string;
  status: "running" | "done";
  tools: SubagentToolExec[];
}

/**
 * Tool names that count as "exploration" — read-only operations that gather
 * information. When the main agent chains these together, they are aggregated
 * into an Explore widget rather than rendered as individual tool messages.
 * File modifications (write_file/edit_file) are NOT included — those stay in
 * the main agent's normal tool-call rendering.
 */
const EXPLORATION_TOOLS = new Set([
  "read_file", "read",
  "list_directory", "ls",
  "grep", "glob", "find",
  "web_search", "search",
  "web_fetch", "fetch_url", "fetch",
]);

/** File-modification tools — rendered as standalone tool messages with diff. */
const FILE_EDIT_TOOLS = new Set([
  "write_file", "write",
  "edit_file", "edit",
]);

function isExplorationTool(name: string): boolean {
  return EXPLORATION_TOOLS.has(name.toLowerCase());
}

function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.toLowerCase());
}

interface PendingFileEdit {
  messageId: string;
  toolName: string;
  filePath: string;
  toolCallId?: string;
  status: "running" | "done" | "error";
  diffStats?: { added: number; removed: number };
}

interface StreamState {
  assistantMessageId: string | null;
  assistantContent: string;
  reasoningContent: string;
  toolCalls: Map<string, ToolCallData>;
  /** Subagent activity, keyed by agent namespace (e.g. "general-purpose"). */
  subagents: Map<string, SubagentTracker>;
  /** Pending file-edit tool calls, keyed by toolCallId (or generated id). */
  fileEdits: Map<string, PendingFileEdit>;
  /** Main-agent exploration tracker (lazy-initialized). */
  mainExplore: SubagentTracker | null;
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
    mainExplore: null,
    fileEdits: new Map(),
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
// Process a single stream event
// =============================================================================

function processStreamEvent(
  event: StreamEvent,
  state: StreamState,
  ctx: ExecutionContext,
): void {
  const { callbacks } = ctx;

  logger.debug("stream event", { status: event.status, threadId: ctx.threadId });

  switch (event.status) {
    case "init": {
      // Server acknowledged the request — update metadata
      const meta = event.meta ?? {};
      if (meta.thread_id && !ctx.threadId) {
        ctx.threadId = meta.thread_id as string;
        ctx.callbacks.onThreadResolved(ctx.threadId);
      }
      break;
    }

    case "loading": {
      const msg = (event.msg ?? {}) as Record<string, unknown>;
      const msgType = msg.type as string | undefined;
      const agentNs = msg.agent_ns as string | undefined;

      // Synthetic subagent_started chunk — carries the system prompt.
      if (msgType === "subagent_started") {
        handleSubagentStarted(state, callbacks, agentNs ?? "subagent", msg);
        break;
      }

      // Messages originating inside a subagent — route to its tracker.
      if (agentNs) {
        handleSubagentMessage(state, callbacks, agentNs, msg, msgType ?? "", event);
        break;
      }

      // Main-agent exploration tools — aggregate into an Explore widget.
      // AI messages with tool_calls register pending tool executions; tool
      // result messages mark them done. Non-exploration tools fall through.
      if (msgType === "ai" || msgType === "AIMessage") {
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls && toolCalls.length > 0) {
          logger.debug("main agent tool_calls", {
            count: toolCalls.length,
            names: toolCalls.map((tc) => tc.name),
            anyExploration: toolCalls.some((tc) => isExplorationTool((tc.name as string) ?? "")),
          });
        }
        if (toolCalls && toolCalls.some((tc) => isExplorationTool((tc.name as string) ?? ""))) {
          handleMainExploreToolCall(state, callbacks, toolCalls);
        }
        // File-edit tools — create standalone tool messages with diff.
        if (toolCalls) {
          for (const tc of toolCalls) {
            const tcName = (tc.name as string) ?? "";
            if (isFileEditTool(tcName)) {
              handleFileEditToolCall(state, callbacks, tcName, (tc.args ?? {}) as Record<string, unknown>, tc.id as string | undefined);
            }
          }
        }
      } else if (msgType === "tool") {
        const toolName = (msg.name as string) ?? "";
        logger.debug("main agent tool result", { toolName, isExploration: isExplorationTool(toolName), hasMainExplore: !!state.mainExplore });
        if (isExplorationTool(toolName) && state.mainExplore) {
          handleMainExploreToolResult(state, callbacks, toolName, msg, event);
          break; // tool result content goes into the Explore widget, not assistant text
        }
        if (isFileEditTool(toolName)) {
          handleFileEditToolResult(state, callbacks, toolName, msg, event);
          break;
        }
      }

      // Main agent token fragment — append to assistant message.
      const token = extractToken(event.response);
      if (token) {
        state.assistantContent += token;
        state.outputTokens++;

        if (!state.assistantMessageId) {
          // Create a new assistant message
          state.assistantMessageId = `msg_${Date.now()}`;
          callbacks.addMessage({
            id: state.assistantMessageId,
            role: "assistant",
            content: token,
            timestamp: Date.now(),
          });
        } else {
          // Update existing message
          callbacks.updateMessage(state.assistantMessageId, {
            content: state.assistantContent,
          });
        }
      }
      break;
    }

    case "reasoning": {
      const msg = (event.msg ?? {}) as Record<string, unknown>;
      const agentNs = msg.agent_ns as string | undefined;

      // Subagent reasoning — route to its tracker (don't pollute main reasoning).
      if (agentNs) {
        handleSubagentMessage(state, callbacks, agentNs, msg, (msg.type as string) ?? "", event);
        break;
      }

      // Main agent reasoning token (thinking/reasoning_content)
      const token = extractToken(event.response);
      if (token) {
        state.reasoningContent += token;
        // Store in metadata for display
        if (state.assistantMessageId) {
          callbacks.updateMessage(state.assistantMessageId, {
            metadata: { reasoning: state.reasoningContent },
          });
        }
      }
      break;
    }

    case "finished": {
      // Agent completed — finalize
      state.requestCount++;
      const meta = event.meta ?? {};
      if (meta.thread_id) {
        ctx.threadId = meta.thread_id as string;
      }
      // Token counts may be in the finished event
      if (typeof meta.input_tokens === "number") {
        state.inputTokens += meta.input_tokens;
      }
      if (typeof meta.output_tokens === "number") {
        state.outputTokens += meta.output_tokens;
      }
      break;
    }

    case "interrupted": {
      // HITL interrupt — the agent is waiting for approval
      callbacks.setSpinner(null);
      callbacks.onInterrupted(event.message ?? event.error_message ?? "Agent paused — awaiting approval");
      break;
    }

    case "ask_user_question_required": {
      // HITL interrupt — the server paused the agent because one or more tool
      // calls (edit_file, write_file, execute, …) need user approval before
      // they execute. The app must show the ApprovalMenu and call
      // resumeAgentTask(approved) to continue.
      callbacks.setSpinner(null);
      const interruptMeta = (event.meta?.interrupt ?? {}) as Record<string, unknown>;
      const questions = (event.questions as unknown[]) ?? (interruptMeta.questions as unknown[]) ?? [];
      const actionRequests = (interruptMeta.actionRequests as unknown[]) ?? [];
      callbacks.onApprovalRequired(questions, actionRequests);
      break;
    }

    case "error": {
      callbacks.onError(event.error_message ?? event.message ?? "Unknown error");
      break;
    }

    case "warning": {
      // Non-fatal warning — display as app message, strip technical IDs
      let text = event.message ?? "Warning";
      // Strip tool call IDs: "Tool call <name> with id <uuid> was cancelled..." → "Tool call <name> was cancelled..."
      text = text.replace(/\s+with\s+id\s+\S+/, "");
      callbacks.addMessage({
        id: `warn_${Date.now()}`,
        role: "app",
        content: `⚠ ${text}`,
        timestamp: Date.now(),
      });
      break;
    }

    default:
      break;
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

  // Mark the main-agent Explore widget as done.
  if (state.mainExplore && state.mainExplore.status === "running") {
    state.mainExplore.status = "done";
    flushMainExplore(callbacks, state.mainExplore);
  }
}

// =============================================================================
// Resume after HITL interrupt
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
    mainExplore: null,
    fileEdits: new Map(),
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

// =============================================================================
// Subagent tracking helpers
// =============================================================================

/**
 * Ensure a SubagentTracker exists for the given namespace, creating the TUI
 * message if necessary.
 */
function ensureSubagent(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  agentNs: string,
): SubagentTracker {
  let tracker = state.subagents.get(agentNs);
  if (!tracker) {
    tracker = {
      messageId: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      agentType: agentNs,
      description: "",
      status: "running",
      tools: [],
    };
    state.subagents.set(agentNs, tracker);
    // Insert before assistant message when possible
    if (state.assistantMessageId) {
      callbacks.insertMessage({
        id: tracker.messageId,
        role: "subagent",
        content: "",
        timestamp: Date.now(),
        metadata: {
          agentType: tracker.agentType,
          description: "",
          status: "running",
          tools: [],
        },
      }, state.assistantMessageId);
    } else {
      callbacks.addMessage({
        id: tracker.messageId,
        role: "subagent",
        content: "",
        timestamp: Date.now(),
        metadata: {
          agentType: tracker.agentType,
          description: "",
          status: "running",
          tools: [],
        },
      });
    }
  }
  return tracker;
}

/** Push the current tracker state to the TUI message. */
function flushSubagent(callbacks: TuiAdapterCallbacks, tracker: SubagentTracker): void {
  callbacks.updateMessage(tracker.messageId, {
    metadata: {
      agentType: tracker.agentType,
      description: tracker.description,
      systemPrompt: tracker.systemPrompt,
      status: tracker.status,
      tools: tracker.tools,
    },
  });
}

/** Handle a `subagent_started` synthetic chunk (carries the system prompt). */
function handleSubagentStarted(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  agentNs: string,
  msg: Record<string, unknown>,
): void {
  const tracker = ensureSubagent(state, callbacks, agentNs);
  tracker.agentType = agentNs;
  tracker.description = (msg.description as string) ?? "";
  tracker.systemPrompt = (msg.system_prompt as string) ?? undefined;
  flushSubagent(callbacks, tracker);
}

/**
 * Handle a message that originated inside a subagent. Tracks the subagent's
 * tool calls (from AIMessages) and their results (from ToolMessages).
 */
function handleSubagentMessage(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  agentNs: string,
  msg: Record<string, unknown>,
  msgType: string,
  event: StreamEvent,
): void {
  const tracker = ensureSubagent(state, callbacks, agentNs);

  // AI message carrying tool_calls → register new pending tool executions.
  if (msgType === "ai" || msgType === "AIMessage") {
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        tracker.tools.push({
          toolName: (tc.name as string) ?? "unknown",
          args: (tc.args as Record<string, unknown>) ?? {},
          status: "running",
          toolCallId: tc.id as string | undefined,
        });
      }
    }
    flushSubagent(callbacks, tracker);
    return;
  }

  // ToolMessage — match a pending tool execution and mark it done.
  if (msgType === "tool") {
    const toolName = (msg.name as string) ?? "";
    const toolCallId = msg.tool_call_id as string | undefined;
    const content = extractToken(event.response) ?? "";

    // Find the most recent pending tool that matches (by id or by name).
    const pending = [...tracker.tools]
      .reverse()
      .find(
        (t) =>
          t.status === "running" &&
          ((toolCallId && t.toolCallId === toolCallId) ||
            (!toolCallId && (!t.toolName || t.toolName === toolName))),
      );
    if (pending) {
      pending.status = "done";
      pending.resultSummary = summarizeToolResult(pending.toolName, content);
    }
    flushSubagent(callbacks, tracker);
    return;
  }

  // Other message types (e.g. subagent reasoning) — no tracking needed.
}

/**
 * Produce a short human-readable summary of a tool's result content.
 * - read_file → word count
 * - execute → first line / exit status
 * - web_search → result count heuristic
 * - fallback → first line truncated
 */
function summarizeToolResult(toolName: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const name = toolName.toLowerCase();
  if (name === "read_file" || name === "read") {
    return `${formatWordCount(trimmed)}`;
  }
  if (name === "execute" || name === "shell" || name === "bash") {
    const firstLine = trimmed.split("\n").find((l) => l.trim()) ?? "";
    return firstLine.slice(0, 80) || "done";
  }
  if (name.includes("search")) {
    return trimmed.slice(0, 60);
  }
  const firstLine = trimmed.split("\n")[0] ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

/** Count words in content — handles CJK characters (counted per-char). */
function formatWordCount(content: string): string {
  // Count CJK characters individually; non-CJK runs split on whitespace.
  const cjkMatches = content.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = content.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ");
  const wordCount = nonCjk.split(/\s+/).filter((w) => w.length > 0).length;
  const total = cjkCount + wordCount;
  if (total >= 10000) return `${(total / 1000).toFixed(1)}k 字`;
  return `${total.toLocaleString()} 字`;
}

// =============================================================================
// Main-agent exploration aggregation
// =============================================================================

/**
 * Ensure the main-agent Explore tracker exists, creating the TUI message
 * if necessary. Lazily initialized on the first exploration tool call.
 */
function ensureMainExplore(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
): SubagentTracker {
  if (state.mainExplore) return state.mainExplore;
  const tracker: SubagentTracker = {
    messageId: `explore_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    agentType: "main",
    description: "",
    status: "running",
    tools: [],
  };
  state.mainExplore = tracker;
  // Insert before the assistant message so Explore appears inline
  if (state.assistantMessageId) {
    callbacks.insertMessage({
      id: tracker.messageId,
      role: "subagent",
      content: "",
      timestamp: Date.now(),
      metadata: {
        agentType: tracker.agentType,
        description: "",
        status: "running",
        tools: [],
      },
    }, state.assistantMessageId);
  } else {
    callbacks.addMessage({
      id: tracker.messageId,
      role: "subagent",
      content: "",
      timestamp: Date.now(),
      metadata: {
        agentType: tracker.agentType,
        description: "",
        status: "running",
        tools: [],
      },
    });
  }
  return tracker;
}

/** Flush the main-agent Explore tracker to its TUI message. */
function flushMainExplore(callbacks: TuiAdapterCallbacks, tracker: SubagentTracker): void {
  callbacks.updateMessage(tracker.messageId, {
    metadata: {
      agentType: tracker.agentType,
      description: tracker.description,
      systemPrompt: tracker.systemPrompt,
      status: tracker.status,
      tools: tracker.tools,
    },
  });
}

/**
 * Handle the main agent's AI message carrying exploration tool_calls.
 * Registers each exploration tool as a pending execution in the Explore widget.
 * Non-exploration tools in the same message are ignored (they render normally).
 */
function handleMainExploreToolCall(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  toolCalls: Array<Record<string, unknown>>,
): void {
  const tracker = ensureMainExplore(state, callbacks);
  for (const tc of toolCalls) {
    const name = (tc.name as string) ?? "";
    if (!isExplorationTool(name)) continue;
    tracker.tools.push({
      toolName: name,
      args: (tc.args as Record<string, unknown>) ?? {},
      status: "running",
      toolCallId: tc.id as string | undefined,
    });
  }
  flushMainExplore(callbacks, tracker);
}

/**
 * Handle a main-agent tool result for an exploration tool. Matches the
 * pending execution and marks it done with a result summary.
 */
function handleMainExploreToolResult(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  toolName: string,
  msg: Record<string, unknown>,
  event: StreamEvent,
): void {
  const tracker = state.mainExplore;
  if (!tracker) return;

  const toolCallId = msg.tool_call_id as string | undefined;
  const content = extractToken(event.response) ?? "";

  // Match by toolCallId if available, else by name + most recent pending.
  const pending = [...tracker.tools]
    .reverse()
    .find(
      (t) =>
        t.status === "running" &&
        ((toolCallId && t.toolCallId === toolCallId) ||
          (!toolCallId && t.toolName === toolName)),
    );
  if (pending) {
    pending.status = "done";
    pending.resultSummary = summarizeToolResult(pending.toolName, content);
  }
  flushMainExplore(callbacks, tracker);
}

// =============================================================================
// File-edit tool handling (edit_file / write_file)
// =============================================================================

/**
 * Register a file-edit tool call. Creates a standalone tool-role message
 * showing the file path and diff stats.
 */
function handleFileEditToolCall(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): void {
  const filePath = (args.file_path ?? args.path ?? "") as string;
  const diffStats = computeDiffStats(toolName, args);
  const id = toolCallId ?? `edit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const messageId = `tool_${id}`;

  state.fileEdits.set(id, {
    messageId,
    toolName,
    filePath,
    toolCallId,
    status: "running",
    diffStats,
  });

  callbacks.addMessage({
    id: messageId,
    role: "tool",
    content: "",
    timestamp: Date.now(),
    metadata: {
      toolName,
      toolStatus: "running",
      toolArgs: args,
      diffStats,
    },
  });
}

/** Handle the result of a file-edit tool — mark done, update the message. */
function handleFileEditToolResult(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  toolName: string,
  msg: Record<string, unknown>,
  event: StreamEvent,
): void {
  const toolCallId = msg.tool_call_id as string | undefined;
  // Find the pending edit by toolCallId, or by matching tool name.
  let entry: PendingFileEdit | undefined;
  if (toolCallId) {
    entry = state.fileEdits.get(toolCallId);
  }
  if (!entry) {
    // Fallback: find last pending edit with matching tool name.
    for (const e of state.fileEdits.values()) {
      if (e.status === "running" && e.toolName === toolName) entry = e;
    }
  }
  if (!entry) return;

  const content = extractToken(event.response) ?? "";
  entry.status = "done";
  callbacks.updateMessage(entry.messageId, {
    metadata: {
      toolName: entry.toolName,
      toolStatus: "done",
      toolArgs: msg,
      diffStats: entry.diffStats,
      result: content.slice(0, 200),
    },
  });
}

/**
 * Compute diff stats (added/removed lines) from tool args.
 * - edit_file: compare old_text vs new_text line by line
 * - write_file: all lines are "added"
 */
function computeDiffStats(
  toolName: string,
  args: Record<string, unknown>,
): { added: number; removed: number } {
  const name = toolName.toLowerCase();
  if (name === "edit_file" || name === "edit") {
    const oldText = (args.old_text ?? args.old_string ?? "") as string;
    const newText = (args.new_text ?? args.new_string ?? "") as string;
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    return {
      added: Math.max(0, newLines.length - oldLines.length) || (newText ? newLines.length : 0),
      removed: oldLines.length,
    };
  }
  if (name === "write_file" || name === "write") {
    const content = (args.content ?? "") as string;
    return { added: content ? content.split("\n").length : 0, removed: 0 };
  }
  return { added: 0, removed: 0 };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract a text token from a stream event response field.
 * The response may be a string, an array of content parts, or an object.
 */
function extractToken(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    // Could be an array of content parts
    return response
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text"
      )
      .map((part) => part.text)
      .join("");
  }
  if (typeof response === "object" && response !== null) {
    // Could be a message object with content
    const obj = response as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}
