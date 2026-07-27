// =============================================================================
// Shared types for the TUI — extracted to avoid circular imports.
// Equivalent to Python tui._ask_user_types + tui._session_stats + tui._cli_context
// =============================================================================

// =============================================================================
// App lifecycle phases
// =============================================================================

export type AppPhase =
  | "connecting"    // Initial server connection
  | "startup_error" // Server connection failed
  | "ready"         // Connected, idle
  | "running"       // Agent is executing
  | "blocked";      // Waiting for user input (HITL approval, ask_user)

export type InputMode = "normal" | "shell" | "shell_incognito";

// =============================================================================
// Ask-user interrupt protocol types
// =============================================================================

export interface Choice {
  /** The display label for this choice. */
  value: string;
}

export interface Question {
  /** The question text to display. */
  question: string;
  /** Question type: 'text' for free-form, 'multiple_choice' for predefined options. */
  type: "text" | "multiple_choice";
  /** Options for multiple_choice questions. An "Other" free-form option is always appended. */
  choices?: Choice[];
  /** Whether the user must answer. Defaults to true if omitted. */
  required?: boolean;
}

export interface AskUserRequest {
  /** Discriminator tag, always 'ask_user'. */
  type: "ask_user";
  /** Questions to present to the user. */
  questions: Question[];
  /** ID of the originating tool call, used to route the response back. */
  tool_call_id: string;
}

export interface AskUserAnswered {
  type: "answered";
  /** User-provided answers, one per question. */
  answers: string[];
}

export interface AskUserCancelled {
  type: "cancelled";
}

export type AskUserWidgetResult = AskUserAnswered | AskUserCancelled;

// =============================================================================
// Session statistics
// =============================================================================

export interface ModelStats {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionStats {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  wallTimeSeconds: number;
  perModel: Record<string, ModelStats>;
}

export type SpinnerStatus = "Thinking" | "Offloading" | null;

// =============================================================================
// CLI runtime context (passed to middleware)
// =============================================================================

export interface CLIContext {
  /** Model spec to swap at runtime (e.g. 'provider:model'). */
  model?: string | null;
  /** Invocation params (e.g. temperature, max_tokens). */
  modelParams?: Record<string, unknown>;
  /** Resolved provider:model spec actually in use. */
  effectiveModel?: string | null;
}

// =============================================================================
// Chat message types
// =============================================================================

export type MessageRole = "user" | "assistant" | "tool" | "error" | "app" | "skill" | "summarization" | "diff" | "subagent";

export interface ChatMessageData {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Tool call lifecycle (used by tui-adapter)
// =============================================================================

export type ToolStatus = "pending" | "running" | "success" | "error" | "rejected" | "awaiting_approval";

export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  output?: string;
  error?: string;
}

// =============================================================================
// Subagent activity (Explore widget) — tracks a subagent's tool executions
// =============================================================================

/**
 * A single tool execution inside a subagent. Tracked as the subagent streams
 * its AIMessages (tool_calls) and ToolMessages (results).
 */
export interface DiffStats {
  added: number;
  removed: number;
}

export interface SubagentToolExec {
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  /** Short human-readable summary of the tool result (e.g. "1,234 字"). */
  resultSummary?: string;
  /** For file-edit tools: line-level change counts. */
  diffStats?: DiffStats;
  toolCallId?: string;
}

/**
 * Metadata stored on a `role: "subagent"` ChatMessageData, describing the
 * subagent's intent, system prompt, and tool execution history.
 */
export interface SubagentActivityMeta {
  /** Subagent type, e.g. "general-purpose". */
  agentType: string;
  /** The task description (what the subagent was asked to do). */
  description: string;
  /** The subagent's system prompt (shown when expanded). */
  systemPrompt?: string;
  status: "running" | "done";
  tools: SubagentToolExec[];
}
