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
  agent_config_id?: number;
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
  | "warning";

/**
 * One NDJSON record. Use `status` to narrow. Optional fields are kept
 * permissive so forward-compatible additions don't require a type bump —
 * only the common, stable fields are declared.
 */
export interface StreamEvent {
  status: StreamStatus;

  /** `loading`/`reasoning` carry the token fragment here. */
  response?: unknown;

  /** LangChain message dump (`{role, content, id, additional_kwargs, ...}`). */
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

  /** `ask_user_question_required` carries the yuxi-shaped questions array. */
  questions?: unknown[];

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
