import { z } from "zod";

// =============================================================================
// Shared request / response types for the Octopus API.
// Phase 1: minimal set — auth + chat streaming.
// =============================================================================

// --- Auth ---

export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const InitRequestSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(6).max(128),
});
export type InitRequest = z.infer<typeof InitRequestSchema>;

export interface User {
  id: string;
  username: string;
  role: "superadmin" | "admin" | "user";
  createdAt?: string;
}

export interface LoginResponse {
  success: boolean;
  user: User;
  access_token: string;
  token_type: string;
}

export interface FirstRunResponse {
  isFirstRun: boolean;
}

// --- Chat ---

/**
 * One multimodal content part. Mirrors the OpenAI/Anthropic message-parts
 * shape so a `HumanMessage(content=[...])` on the Python side round-trips
 * without translation.
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  /** Plain text, or a multimodal parts array (OpenAI-style). */
  content: string | ChatContentPart[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  thread_id?: string;
  /** Agent/subagent id to scope the conversation (aligns with server's ChatRequest.agent_id). */
  agent_id?: string;
  /** Workspace to bind the thread to (its dir becomes the agent's cwd). */
  workspace_id?: string;
  /** Optional per-request model override ("provider:model"). Applied server-side
   *  via the configurable_model middleware; omitted = use config default. */
  model?: string;
  /** Primary agent name: "plan" | "confirm" | "auto" | "full" — the
   *  agent-based successor of the access mode (every legacy mode IS a
   *  builtin agent; see @octopus/core agents/builtin.ts).
   *  plan   = read-only (destructive tools stripped) + plan approval gate.
   *  confirm= per-step HITL approval (default).
   *  auto   = HITL suppressed (but FileEditGuard still redirects shell writes).
   *  full   = HITL suppressed AND FileEditGuard bypassed (fully autonomous). */
  agent?: "plan" | "confirm" | "auto" | "full";
  /** Legacy access-mode field — folded into `agent` server-side. @deprecated */
  mode?: "plan" | "confirm" | "auto" | "full";
  /** Optional client-generated request id, used for optimistic UI correlation. */
  request_id?: string;
}

/** Options shared by streaming calls (chat + resume). */
export interface StreamCallOptions {
  /**
   * Optional AbortSignal. When aborted, the in-flight fetch is cancelled and
   * the async generator stops. The server is expected to also see a client
   * disconnect and persist any partial output (see chat_service.py's
   * `asyncio.CancelledError` handler).
   */
  signal?: AbortSignal;
}

// --- Threads ---

export interface Thread {
  id: string;
  userId: string;
  title: string;
  agentId: string;
  /** Workspace this thread is bound to (optional for back-compat). */
  workspaceId?: string | null;
  /** True when the thread has an agent run still executing server-side
   *  (background continuation — set by GET /threads, optional for back-compat). */
  running?: boolean;
  createdAt: string;
}

export interface ThreadListResponse {
  threads: Thread[];
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Record<string, unknown>[];
  feedback?: { rating: "like" | "dislike" };
  extraMetadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadHistoryResponse {
  history: MessageRow[];
}

// =============================================================================
// Ask-the-user protocol — unified surface for all human-in-the-loop requests.
//
// Three `kind` of requests share the same NDJSON status
// (`ask_user_question_required`) and the same input-area UI on the client:
//   - tool_approval : LangChain humanInTheLoopMiddleware interrupt (execute /
//                     write_file / web_search / ...). The user approves or
//                     rejects one or more pending tool calls.
//   - discussion    : the agent called the `ask_user_question` tool with a
//                     fixed list of options; the user picks one (or several
//                     when multi_select). Optional free-text via allow_other.
//   - clarify       : the agent called `ask_user_question` without options;
//                     the user types a free-text answer.
//
// The discriminant flows through `interrupt.value.kind` (set by the agent) and
// is inferred server-side when absent (actionRequests → tool_approval,
// options → discussion, else clarify). `question_id` is stable across
// interrupt + resume so answers can be paired back to their questions.
// =============================================================================

/** Discriminator for the request kinds. */
export type AskKind = "tool_approval" | "plan_approval" | "discussion" | "clarify";

/** A single selectable option inside a question. */
export interface QuestionOption {
  label: string;
  /** Value returned to the agent on selection. */
  value: string;
  /** Optional helper text shown beneath the label. */
  description?: string;
}

/**
 * One question posed to the user. `question_id` is the correlation key for
 * the matching answer in the resume body.
 */
export interface AskQuestion {
  /** Stable id (assigned by the agent at interrupt time, NOT regenerated per emit). */
  question_id: string;
  /** Full question text. */
  question: string;
  /** Short label (≤12 chars) for the header chip. */
  header?: string;
  /** Options list; omitted means a free-text (clarify) question. */
  options?: QuestionOption[];
  /** Allow multiple selections (discussion only). Defaults to false. */
  multi_select?: boolean;
  /** Show an "Other…" free-text input alongside the options. Defaults to false. */
  allow_other?: boolean;
  /** tool_approval only — the pending tool calls awaiting a decision. */
  context?: {
    actionRequests?: Array<{
      name: string;
      args: Record<string, unknown>;
      description?: string;
    }>;
    /** Which tool triggered the interrupt (for the header chip). */
    source?: string;
    /** Per-action allowed decisions surfaced from reviewConfigs. */
    reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>;
  };
}

/** The full payload carried by an `ask_user_question_required` chunk. */
export interface AskUserQuestionPayload {
  kind: AskKind;
  questions: AskQuestion[];
  thread_id: string;
}

/**
 * Resume request body for `POST /api/chat/thread/:id/resume`.
 *
 * Backwards-compatible: a legacy client sending only `{ approved: boolean }`
 * is treated as `kind: "tool_approval"` with a single all-approve/all-reject
 * decision. New clients send the structured form.
 */
export interface ResumeRequestBody {
  /** Legacy field — kept for old clients; server folds it into `decisions`. */
  approved?: boolean;
  /** Discriminator; inferred server-side when omitted. */
  kind?: AskKind;
  /** plan_approval — revision feedback when the plan is rejected. */
  feedback?: string;
  /** tool_approval answers (one per actionRequest, in order). */
  decisions?: Array<
    | { type: "approve" }
    | { type: "always"; tool?: string }
    | { type: "reject"; message?: string }
    | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }
  >;
  /** discussion / clarify answers, keyed by question_id. */
  answers?: Array<{
    question_id: string;
    /** Single value (radio) or values (checkbox). */
    selection?: string | string[];
    /** Free-text — clarify answer, or the "Other…" supplement when allow_other. */
    text?: string;
  }>;
}

// =============================================================================
// Stream events (NDJSON protocol)
//
// Wire format: one JSON object per line (`\n`), each carrying a `status`
// discriminator. The set below mirrors the statuses emitted by the Python
// `chat_service.stream_agent_chat` / `stream_agent_resume` functions:
//
//   init, loading, reasoning, agent_state, ask_user_question_required,
//   finished, interrupted, error, warning.
//
// `loading` carries a token fragment; `reasoning` carries a reasoning token
// fragment (additional_kwargs.reasoning_content); the rest carry metadata.
// =============================================================================

export type StreamStatus =
  | "init"
  | "loading"
  | "reasoning"
  | "agent_state"
  | "ask_user_question_required"
  | "finished"
  | "interrupted"
  | "error"
  | "warning"
  /** /events only: the thread has no active run (client falls back to /history). */
  | "idle"
  /** /events only: 10s keepalive, no payload — safe to ignore. */
  | "heartbeat";

/**
 * One NDJSON record. Use `status` to narrow. Optional fields are kept
 * permissive so forward-compatible additions don't require a type bump —
 * only the common, stable fields are declared.
 */
export interface StreamEvent {
  status: StreamStatus;

  /** `loading`/`reasoning` carry the token fragment here. */
  response?: unknown;

  /**
   * LangChain message dump. Common keys: `{ type, content }`. The server may
   * also attach:
   * - `agent_ns` — subagent type (e.g. "general-purpose") when the message
   *   originated inside a subagent.
   * - `tool_calls` — array of `{ id, name, args }` on AIMessages.
   * - `tool_call_id` / `name` — on ToolMessages, identify which tool ran.
   * - `type: "subagent_started"` — synthetic chunk announcing a subagent is
   *   about to run; carries `agent_ns`, `description`, `system_prompt`.
   * - `type: "subagent_finished"` — synthetic chunk announcing a subagent has
   *   returned its result to the main agent; carries `agent_ns`. Drives the
   *   UI's "collapse on completion" for nested subagent timelines.
   */
  msg?: Record<string, unknown>;

  /** Per-chunk request id; omitted on the first `init` (see chat_service). */
  request_id?: string;

  /** Per-request metadata bag: thread_id, agent_id, user_id, time_cost, … */
  meta?: Record<string, unknown>;

  /** `error` chunk type tag — `agent_error` / `invalid_config` / `unexpected_error`. */
  error_type?: string;
  /** `error`/`interrupted` human-readable message. */
  error_message?: string;

  /** `warning`/`interrupted` carry a free-text message here. */
  message?: string;

  /**
   * `ask_user_question_required` payload. `questions` is the typed array;
   * `kind` / `actionRequests` / `source` / `thread_id` are also lifted to
   * top-level fields for direct access (the server emits them via spread).
   */
  questions?: AskQuestion[];
  /** Discriminator for the ask payload (see AskUserQuestionPayload). */
  kind?: AskKind;
  /** tool_approval — the pending tool calls (mirror of questions[].context). */
  actionRequests?: NonNullable<NonNullable<AskQuestion["context"]>["actionRequests"]>;
  /** tool_approval — the source tool name. */
  source?: string;
  /** thread_id the ask is bound to. */
  thread_id?: string;

  /** `agent_state` carries `{todos, files, artifacts}`. */
  agent_state?: Record<string, unknown>;

  /** LangGraph stream metadata (langgraph_node, langgraph_step, …). */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Raised when the streaming endpoint returns a non-2xx response (the server
 * sends a JSON `{detail: "..."}` body on auth failures, invalid configs,
 * etc.). Carries the HTTP status and the parsed detail.
 */
export class StreamHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(detail || `Stream request failed: ${status}`);
    this.name = "StreamHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Raised when an `error` chunk is observed in the stream itself (i.e. the
 * server-side graph blew up mid-stream). Carries the server's error_type
 * tag for programmatic handling.
 */
export class StreamServerError extends Error {
  readonly errorType: string;
  readonly event: StreamEvent;
  constructor(event: StreamEvent) {
    super(event.error_message ?? event.message ?? "Stream error");
    this.name = "StreamServerError";
    this.errorType = event.error_type ?? "unexpected_error";
    this.event = event;
  }
}

// =============================================================================
// Config management — skills + MCP servers
//
// Mirrors the shared contract in core/src/config_types.ts. `origin` drives
// editability in the web/tui UI (only "user-defined" entries are editable).
// =============================================================================

/** Where a skill entry came from — determines editability. */
export type SkillOrigin = "builtin" | "file" | "user-defined";

/** Where an MCP server entry came from — determines editability. */
export type McpOrigin = "file" | "user-defined";

/** A skill entry in the unified config view. */
export interface SkillEntry {
  name: string;
  /** file/builtin entries carry the source path; user-defined omit it. */
  path?: string;
  source?: string;
  origin: SkillOrigin;
  editable: boolean;
  description: string;
  /** True for a builtin skill with no user-defined copy yet (one-click install). */
  installable?: boolean;
}

/** Skill detail (GET /api/config/skills/:name). */
export interface SkillDetail {
  content: string;
  origin: SkillOrigin;
  editable: boolean;
  description: string;
}

/** An MCP server entry in the unified config view. */
export interface McpServerEntry {
  name: string;
  origin: McpOrigin;
  editable: boolean;
  transport: "stdio" | "sse" | "http" | "streamable-http";
  /** command/args/env (stdio) or url/headers (sse/http). */
  config: Record<string, unknown>;
  /** Disabled state (runtime, persisted server-side). */
  enabled: boolean;
  /** Connection status — only populated when list is called with probe=true. */
  status?: string;
  /** Error detail when status !== "ok". */
  error?: string;
}

/** Create/update skill request body. */
export interface SkillWriteRequest {
  name?: string;
  description?: string;
  content?: string;
}

/** Create/update MCP server request body. */
export interface McpWriteRequest {
  name?: string;
  transport?: "stdio" | "sse" | "http" | "streamable-http";
  config?: Record<string, unknown>;
}

// =============================================================================
// Config management — subagents
// =============================================================================

/**
 * Where a subagent entry came from — determines editability.
 * - "file": discovered from an AGENTS.md file (read-only).
 * - "user-defined": created via the web UI / DB (editable).
 * - "builtin": ships with Octopus (Explore, general-purpose) — read-only in
 *   the UI. Explore is always injected at runtime.
 */
export type SubagentOrigin = "file" | "user-defined" | "builtin";

/** A subagent entry in the unified config view. */
export interface SubagentEntry {
  name: string;
  description: string;
  systemPrompt: string;
  /** Optional model override in 'provider:model-name' format. */
  model?: string | null;
  /** Tool name whitelist (strings). */
  tools: string[];
  origin: SubagentOrigin;
  editable: boolean;
  /** Runtime enabled state (user-defined only; file entries are always enabled). */
  enabled: boolean;
  source?: string;
  path?: string;
}

/** Create/update subagent request body. */
export interface SubagentWriteRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  /** Pass null to clear the model override. */
  model?: string | null;
}

// =============================================================================
// Settings — model providers + general (tool toggles, system info)
// =============================================================================

/** A model provider row (secrets never surfaced — only credential presence). */
export interface ModelProviderEntry {
  name: string;
  /** Friendly display name (falls back to `name`). */
  displayName: string;
  /** Protocol/SDK type if set, else null. */
  apiType: string | null;
  enabled: boolean;
  /** true if a key is set, false if env is known but empty, null if unknown. */
  hasCredentials: boolean | null;
  apiKeyEnv: string | null;
  baseUrl: string | null;
  models: string[];
  /** Whether this provider is in the built-in registry (vs user-defined). */
  builtIn: boolean;
}

/** Single-provider detail view (adds literal-key presence flag). */
export interface ModelProviderDetail extends ModelProviderEntry {
  hasApiKeyLiteral: boolean;
}

/** Response for `GET /api/config/models`. */
export interface ModelSettingsResponse {
  providers: ModelProviderEntry[];
  default_model: string | null;
}

/** A model discovered from a provider's live `/models` endpoint. */
export interface RemoteModel {
  id: string;
  displayName: string;
  type: "chat" | "embedding" | "rerank";
  contextLength: number | null;
}

/** Patch body for `PUT /api/config/models/:name`. All fields optional. */
export interface ModelProviderPatch {
  enabled?: boolean;
  /** Write-only — overwrites config.json `api_key`. Empty string clears it. */
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  models?: string[];
  /** Friendly display name. */
  displayName?: string;
  /** Protocol/SDK type (openai / anthropic / ollama / openai-compatible ...). */
  apiType?: string;
  /** New provider key — renames the entry when different. */
  newName?: string;
}

/** Persisted general tool toggles (config.json `settings.tools`). */
export interface GeneralTools {
  enableShell?: boolean;
  enableWebSearch?: boolean;
  interactive?: boolean;
  autoApprove?: boolean;
}

/** Read-only system/environment info. */
export interface SystemInfo {
  configPath: string;
  defaultModel: string | null;
  providersCount: number;
  nodeVersion: string;
  platform: string;
}

/** Response for `GET /api/config/settings`. */
export interface GeneralSettingsResponse {
  /** Persisted user intent. */
  tools: GeneralTools;
  /** Effective values (env wins over config). */
  effective: GeneralTools;
  system_info: SystemInfo;
}

// =============================================================================
// Workspaces — filesystem-backed, DB-tracked directories bound to threads.
//
// A workspace is a per-user directory whose path the agent uses as `cwd`. The
// directory tree IS the file tree; only workspace metadata (id/name/path) is
// stored as rows. See server/src/services/workspace.service.ts.
// =============================================================================

export interface Workspace {
  id: string;
  userId: string;
  name: string;
  /** Absolute host filesystem path of the workspace directory. */
  path: string;
  /** "local" = host dir the agent operates in; "sandbox" = future isolated
   *  container (placeholder this iteration — file ops unavailable). */
  environment: "local" | "sandbox";
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Timestamp the user last opened this workspace (recents ordering). */
  lastOpenedAt?: string | null;
}

/** Create/update workspace request body. */
export interface WorkspaceWriteRequest {
  name?: string;
  description?: string | null;
  /** "local" creates a real host dir; "sandbox" is a placeholder row only. */
  environment?: "local" | "sandbox";
  /** Optional absolute host path to bind as the workspace root (local only). */
  path?: string;
}

/** A subdirectory entry returned by the host directory browser. */
export interface HostDirEntry {
  name: string;
  /** Absolute path of the directory. */
  path: string;
}

/** Response from GET /api/workspace/browse — powers the 本机目录 picker. */
export interface HostBrowseResult {
  /** The absolute path that was listed. */
  current: string;
  /** Subdirectories (files excluded). */
  entries: HostDirEntry[];
  /** Configured browsable roots for the picker's root selector. */
  roots: string[];
}

// =============================================================================
// Sandbox settings — config.json `sandbox` section. Credentials are write-only.
// =============================================================================

/** Response from GET /api/config/sandbox. */
export interface SandboxSettings {
  enabled: boolean;
  provider: "langsmith";
  hasCredentials: boolean;
  apiKeyEnv: string | null;
  templateName: string | null;
  snapshotId: string | null;
}

/** Patch body for PUT /api/config/sandbox. `apiKey` is write-only. */
export interface SandboxSettingsPatch {
  enabled?: boolean;
  provider?: "langsmith";
  /** Set to "" to clear the stored literal key. */
  apiKey?: string;
  apiKeyEnv?: string | null;
  templateName?: string | null;
  snapshotId?: string | null;
}

/** A node in a workspace file tree listing. */
export interface WorkspaceEntry {
  name: string;
  /** Forward-slash relative path within the workspace root ("" = root). */
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

/** Preview classification returned by the read-file endpoint. */
export type PreviewType =
  | "image"
  | "pdf"
  | "markdown"
  | "text"
  | "html"
  | "code"
  | "unsupported";

/** Response from GET /api/workspace/:id/file. */
export interface WorkspaceFileContent {
  name: string;
  path: string;
  content: string | null;
  previewType: PreviewType;
  supported: boolean;
  message?: string;
}

/** Response from GET /api/workspace/:id/tree. */
export interface WorkspaceTreeResponse {
  entries: WorkspaceEntry[];
}

/** Response from list workspaces. */
export interface WorkspaceListResponse {
  workspaces: Workspace[];
}

/** Result of an upload. */
export interface WorkspaceUploadResult {
  path: string;
  name: string;
  size: number;
}

// =============================================================================
// Slash commands — user-customizable input shortcuts
// =============================================================================

/** Discriminator: system commands execute app actions; prompt commands insert templates. */
export type SlashCommandKind = "system" | "prompt";

/** Actions for built-in system commands. Maps to platform-specific behavior. */
export type SystemAction =
  | "clear"
  | "theme"
  | "help"
  | "copy-last"
  | "search"
  | "changelog"
  | "version"
  | "feedback"
  | "docs"
  | { type: "navigate"; path: string }
  // TUI-only (reserved)
  | "model"
  | "agents"
  | "editor"
  | "quit"
  | "notifications"
  | "threads"
  | "update"
  | "install"
  | "auto-update"
  | "tokens"
  | "trace"
  | "offload"
  | "remember"
  | "skill-creator";

/** Platform filter for built-in commands (user-defined have no platform restriction). */
export type SlashCommandPlatform = "web" | "tui" | "all";

/** Where a slash-command entry came from — determines editability. */
export type SlashCommandOrigin = "builtin" | "user-defined";

/** A slash-command entry in the unified config view. */
export interface SlashCommandEntry {
  id: string;
  /** Command name (e.g. "clear", "translate"). */
  name: string;
  /** Human-readable display name (e.g. "清空对话"). */
  displayName: string;
  /** Short description shown in the autocomplete menu. */
  description: string;
  /** "system" = built-in app action; "prompt" = user-defined template. */
  kind: SlashCommandKind;
  /** System command action (only when kind === "system"). */
  systemAction?: SystemAction | null;
  /** Template with {input} placeholder (only when kind === "prompt"). */
  promptTemplate?: string | null;
  /** "insert" = fill template; "send" = fill + auto-send (only when kind === "prompt"). */
  action?: "insert" | "send" | null;
  origin: SlashCommandOrigin;
  editable: boolean;
  /** Built-in-command platform tag. Null for user-defined commands. */
  platform?: SlashCommandPlatform | null;
  /** Optional grouping category. */
  category?: string | null;
}

/** Create/update slash command request body (user-defined prompt commands only). */
export interface SlashCommandWriteRequest {
  name?: string;
  displayName?: string;
  description?: string;
  promptTemplate?: string;
  action?: "insert" | "send";
  category?: string | null;
}
