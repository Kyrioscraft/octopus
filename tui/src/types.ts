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

/**
 * One selectable option. We accept both the wire shape
 * (`{ label, value, description }`) and a legacy `{ value }` shorthand.
 */
export interface Choice {
  /** The display label for this choice. Defaults to `value` when absent. */
  label?: string;
  /** The value returned to the agent on selection. */
  value: string;
  /** Optional helper text shown beneath the label. */
  description?: string;
}

export interface Question {
  /** Stable id used to pair the answer back on resume (wire protocol). */
  question_id?: string;
  /** The question text to display. */
  question: string;
  /** Short label (≤12 chars) for the header chip (wire protocol). */
  header?: string;
  /** Question type: 'text' for free-form, 'multiple_choice' for predefined options. */
  type?: "text" | "multiple_choice";
  /**
   * Options for multiple_choice questions. Mirrors the wire `options` field.
   * `choices` is kept as a legacy alias — `AskUserMenu` reads `options` first.
   */
  options?: Choice[];
  /** Legacy alias for `options` (older callers). */
  choices?: Choice[];
  /** Allow multiple selections (discussion only). Defaults to false. */
  multi_select?: boolean;
  /** Show an "Other…" free-text input alongside the options. Defaults to false. */
  allow_other?: boolean;
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

/** One answered question, keyed by `question_id` (matches ResumeRequestBody). */
export interface AskUserAnswerEntry {
  question_id: string;
  /** Single value (radio) or values (checkbox). */
  selection?: string | string[];
  /** Free-text — clarify answer, or the "Other…" supplement when allow_other. */
  text?: string;
}

export interface AskUserAnswered {
  type: "answered";
  /** User-provided answers, one per question (same order as `questions`). */
  answers: AskUserAnswerEntry[];
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

// =============================================================================
// AgentBlock data model — block-level rendering units within a turn.
// Equivalent to Python (new design per tui-solution.md).
//
// Each agent turn (user → assistant) is composed of multiple AgentBlocks
// that have independent lifecycles: thinking, text streaming, tool calls,
// and confirmation prompts. Completed blocks are immediately frozen into
// Ink's <Static> to avoid React diff on historical content.
// =============================================================================

/** Unique identifier for an AgentBlock. */
export type BlockId = string;

/** Block lifecycle status. */
export type BlockStatus =
  | "pending"      // About to start (tool_call / confirm only)
  | "running"      // In progress (thinking / tool_call)
  | "streaming"    // Streaming output (text only)
  | "done"         // Completed
  | "approved"     // User approved (confirm only)
  | "rejected";    // User rejected (confirm only)

/** AgentBlock discriminated union — the minimum renderable unit. */
export type AgentBlock =
  // ── Thinking / reasoning ──
  | {
      id: BlockId;
      type: "thinking";
      status: "running" | "done";
      /** Thinking content (some models stream thinking tokens). */
      content?: string;
    }

  // ── Streaming text reply ──
  | {
      id: BlockId;
      type: "text";
      status: "streaming" | "done";
      content: string;
    }

  // ── Tool call ──
  | {
      id: BlockId;
      type: "tool_call";
      status: "pending" | "running" | "done";
      /** Tool name, e.g. "read_file". */
      tool: string;
      /** Tool arguments. */
      input: Record<string, unknown>;
      /** Tool return value (present when done). */
      output?: string;
      /** Error message (present on failure). */
      error?: string;
    }

  // ── User confirmation ──
  | {
      id: BlockId;
      type: "confirm";
      status: "pending" | "approved" | "rejected";
      /** Confirmation prompt, e.g. "确认执行: rm -rf /dist ?". */
      message: string;
      /** Optional action description. */
      action?: string;
      /** Result text after approval. */
      result?: string;
    };

/** A single conversation turn: one user message + one assistant reply (multiple blocks). */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  blocks: AgentBlock[];
  /** Whether this turn has fully completed. */
  finished: boolean;
}

/** Global session state — all turns + pending confirmation tracking. */
export interface SessionState {
  turns: Turn[];
  /** Block ID of the currently pending confirmation (at most one at a time). */
  pendingConfirm: BlockId | null;
}

/** Callbacks produced by the agent core and consumed by the TUI renderer. */
export interface BlockStreamCallbacks {
  // ── thinking ──
  onThinkingStart: (id: BlockId) => void;
  onThinkingEnd: (id: BlockId, content?: string) => void;

  // ── text ──
  onTextStart: (id: BlockId) => void;
  onTextDelta: (id: BlockId, token: string) => void;
  onTextEnd: (id: BlockId) => void;

  // ── tool_call ──
  onToolStart: (id: BlockId, tool: string, input: Record<string, unknown>) => void;
  onToolEnd: (id: BlockId, output: string, error?: string) => void;

  // ── confirm ──
  onConfirm: (id: BlockId, message: string, action?: string) => Promise<boolean>;

  // ── turn lifecycle ──
  onTurnStart: () => void;
  onTurnEnd: () => void;
}
