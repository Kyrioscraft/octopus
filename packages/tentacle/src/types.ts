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
  /** Thread-level agent (access_mode) — the user's most recent explicit
   * choice. Present on current servers; optional for back-compat. */
  accessMode?: "plan" | "confirm" | "auto" | "full";
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
  /** Thread-level agent (access_mode) — the user's most recent explicit
   *  choice. Absent on older servers; clients fall back to message metadata. */
  agent?: "plan" | "confirm" | "auto" | "full";
}

// =============================================================================
// Thread snapshot (P1) — GET /thread/:id/messages
//
// One atomic hydration response replacing the replay-from-0 history path: the
// raw durable events (verbatim wire shape, minus volatile deltas — those
// never persist), plus the server-authoritative resume cursor (`maxSeq`,
// covering BOTH persisted events and any live volatile seqs already assigned
// — a stateless cursor: the client doesn't track or trust its own), plus the
// trailing pending-ask when the thread is paused at an unanswered interrupt.
// Clients render history by feeding `events` through the same
// TurnEventAccumulator + projectTurnParts as live streaming, then subscribe
// to /events?after=maxSeq.
// =============================================================================

export interface ThreadSnapshotResponse {
  /** Thread id. */
  threadId: string;
  /** All durable events (ascending seq). Deltas excluded by construction. */
  events: DurableStreamEvent[];
  /**
   * Subscribe-after cursor: the highest seq the server has ASSIGNED on this
   * thread (durable or volatile) at snapshot time. Authoritative — clients
   * must not advance past it with local state.
   */
  maxSeq: number;
  /** Trailing unanswered ask — restore the ask panel when present. The
   *  thread is paused server-side (or the run registry was lost to a restart;
   *  the pending ask in the log is still answerable via /resume). */
  pendingAsk: {
    kind: AskKind;
    questions: AskQuestion[];
    thread_id: string;
  } | null;
  /** Whether the thread has a live run executing right now (true → the
   *  client should attach a live tail right after hydrating). */
  running: boolean;
  /** Thread-level agent (access_mode) — restored into the input-bar
   *  selector; mirrors GET /history's `agent`. */
  agent?: "plan" | "confirm" | "auto" | "full";
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
// Typed stream events (v2 NDJSON protocol)
//
// Wire format: one JSON object per line (`\n`), discriminated by `type`.
// Replaces the legacy `status`-discriminated v1 bag. Content events carry
// stable ids (`messageId` / `toolCallId` / `instanceKey`) so the
// client applies targeted patches instead of re-deriving structure from a
// LangChain message dump.
//
// Design notes:
// - delta events are append-only fragments; the client accumulates.
// - `seq` is assigned per-thread by the server (run-registry / thread_events
//   row) and used by the `/events?after=` replay protocol.
// - `agentNs` scopes an event to a subagent instance (the LangGraph
//   checkpoint-ns first segment, e.g. "tools:<run-id>"). Absent = main agent.
// =============================================================================

/**
 * Discriminator for StreamEvent.
 */
export type StreamEventType = StreamEvent["type"];

// =============================================================================
// Event layering (P0 protocol).
//
//   DurableStreamEvent  — carries a persisted `seq`. This IS the verbatim
//                         record of what the model did (audit + replay source
//                         of truth). Never filtered or rewritten by view
//                         concerns.
//   VolatileStreamEvent  — high-frequency deltas. Assigned a live seq for
//                         transport ordering only, NEVER persisted: replay
//                         reconstructs from the terminal full-value events
//                         (text.ended / reasoning.ended / tool.result), so
//                         there is no compact pass and no compact race.
//   ControlStreamEvent   — transport keepalive/close frames. NO seq ever;
//                         must not advance any replay cursor.
// =============================================================================

/** Persisted events — the durable per-thread event log (`thread_events`). */
export type DurableStreamEvent =
  // --- turn lifecycle (emitted by the chat service layer) ---
  | { type: "turn.started"; seq: number; threadId: string; requestId: string; runStartedAt: number; /** The user's turn text — present ONLY on fresh turns (POST /agent); resume turns omit it, continuing the same turn without a new user bubble. Plain string — matches the server's BoundaryEvent. */ userMessage?: string }
  | { type: "turn.finished"; seq: number; threadId: string; title?: string; durationMs: number }
  | { type: "thread.title.updated"; seq: number; threadId: string; title: string }
  | { type: "turn.error"; seq: number; errorType: string; message: string; threadId?: string }
  | { type: "turn.interrupted"; seq: number; partialSaved: boolean; durationMs: number }
  // --- terminal full-value events (replayable; reconstruct state without deltas) ---
  | { type: "text.ended"; seq: number; messageId: string; agentNs?: string; text: string }
  | { type: "reasoning.ended"; seq: number; messageId: string; agentNs?: string; text: string }
  // --- tool calls (first-class events, keyed by toolCallId) ---
  | { type: "tool.started"; seq: number; toolCallId: string; name: string; agentNs?: string }
  | { type: "tool.result"; seq: number; toolCallId: string; result: string; isError: boolean; agentNs?: string }
  // --- subagents (explicit lifecycle; no heuristic inference client-side) ---
  | {
      type: "subagent.started";
      seq: number;
      /** task tool_call_id — stable correlation key across started/finished. */
      callId: string;
      /** Resolved instance key ("tools:<run-id>") when known, else the pending key "pending:<callId>". */
      instanceKey: string;
      description: string;
      subagentName: string;
    }
  | { type: "subagent.finished"; seq: number; instanceKey: string }
  // --- HITL ask (payload identical to the legacy ask_user_question_required chunk) ---
  | { type: "ask"; seq: number; kind: AskKind; questions: AskQuestion[]; threadId?: string; thread_id?: string }
  // --- HITL ask answer (persisted by POST /resume BEFORE the resumed run's
  //     events) — models ask as a request/response pair so any consumer can
  //     tell an answered ask from a pending one without inference ---
  | { type: "ask.resolved"; seq: number; kind: AskKind; resolution: ResumeRequestBody };

/** Live-only deltas — never persisted; replay reconstructs from the
 *  terminal `*.ended` / `tool.result` durable events above. */
export type VolatileStreamEvent =
  | { type: "text.delta"; seq: number; messageId: string; agentNs?: string; delta: string }
  | { type: "reasoning.delta"; seq: number; messageId: string; agentNs?: string; delta: string }
  | { type: "tool.args.delta"; seq: number; toolCallId: string; index: number; argsDelta: string; agentNs?: string };

/** Transport control (/events endpoint) — NO seq, never persisted, never
 *  advances a replay cursor. */
export type ControlStreamEvent =
  | { type: "idle"; threadId?: string }
  | { type: "heartbeat" };

export type StreamEvent = DurableStreamEvent | VolatileStreamEvent | ControlStreamEvent;

/** Narrow a wire event to the persisted (replayable) subset. */
export function isDurableEvent(ev: StreamEvent): ev is DurableStreamEvent {
  return ev.type !== "idle" && ev.type !== "heartbeat" &&
    ev.type !== "text.delta" && ev.type !== "reasoning.delta" && ev.type !== "tool.args.delta";
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
    super(
      (event.type === "turn.error" ? event.message : undefined) ?? "Stream error",
    );
    this.name = "StreamServerError";
    this.errorType = event.type === "turn.error" ? event.errorType : "unexpected_error";
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
