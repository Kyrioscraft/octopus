import { parseNDJSONStream } from "./stream.js";
import {
  StreamHttpError,
  type ChatRequest,
  type FirstRunResponse,
  type InitRequest,
  type LoginRequest,
  type LoginResponse,
  type StreamCallOptions,
  type StreamEvent,
  type Thread,
  type ThreadListResponse,
  type ThreadHistoryResponse,
  type User,
} from "./types.js";

// =============================================================================
// OctopusClient — typed HTTP client for the Octopus server API.
// =============================================================================

export class OctopusClient {
  readonly #baseUrl: string;
  #token: string | null = null;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    this.#baseUrl = opts.baseUrl?.replace(/\/$/, "") ?? "http://127.0.0.1:5050";
    this.#token = opts.token ?? null;
  }

  get token(): string | null {
    return this.#token;
  }

  setToken(t: string | null): void {
    this.#token = t;
  }

  // =========================================================================
  // Auth
  // =========================================================================

  /** Check if this is the first run (no users in the system). */
  async checkFirstRun(): Promise<FirstRunResponse> {
    return this.#get("/api/auth/check-first-run");
  }

  /** Initialize the system with a superadmin user. */
  async initialize(body: InitRequest): Promise<LoginResponse> {
    const res = await this.#post<LoginResponse>("/api/auth/initialize", body);
    this.#token = res.access_token;
    return res;
  }

  /** Login with username + password. */
  async login(body: LoginRequest): Promise<LoginResponse> {
    const res = await this.#post<LoginResponse>("/api/auth/login", body);
    this.#token = res.access_token;
    return res;
  }

  /** Get the current user profile. */
  async getMe(): Promise<User> {
    return this.#get<User>("/api/auth/me");
  }

  // =========================================================================
  // Threads
  // =========================================================================

  /** List threads for the current user. */
  async listThreads(): Promise<Thread[]> {
    const res = await this.#get<ThreadListResponse>("/api/chat/threads");
    return res.threads;
  }

  /** Get message history for a thread. */
  async getThreadHistory(threadId: string): Promise<ThreadHistoryResponse> {
    return this.#get<ThreadHistoryResponse>(`/api/chat/thread/${threadId}/history`);
  }

  /** Delete a thread. */
  async deleteThread(threadId: string): Promise<void> {
    await this.#delete(`/api/chat/thread/${threadId}`);
  }

  /** Rename a thread. */
  async renameThread(threadId: string, title: string): Promise<void> {
    await this.#put(`/api/chat/thread/${threadId}`, { title });
  }

  // =========================================================================
  // Chat — NDJSON streaming
  //
  // The server responds with `Content-Type: application/x-ndjson` +
  // `Transfer-Encoding: chunked`. Each line is a JSON object carrying a
  // `status` discriminator (init / loading / reasoning / agent_state /
  // ask_user_question_required / finished / interrupted / error / warning).
  // See `parseNDJSONStream` for the wire-format rationale.
  // =========================================================================

  /**
   * Send a chat message and receive an async iterable of stream events.
   *
   * Does NOT buffer the entire response — use `for await` to process tokens
   * as they arrive. Pass an `AbortSignal` via `opts.signal` to let the user
   * cancel a generation mid-stream; aborting cancels the fetch and stops the
   * generator (the server sees the disconnect and persists partial output).
   *
   * The request body is sent verbatim — backend, tentacle, and frontend all
   * share the same OpenAI/Anthropic-style `{messages, thread_id, …}` shape.
   * The server stores the new user turn and reconstructs prior history from
   * the LangGraph checkpointer keyed by `thread_id`, so callers normally send
   * only the new user turn.
   */
  async streamAgentChat(
    body: ChatRequest,
    opts: StreamCallOptions = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    const response = await fetch(`${this.#baseUrl}/api/chat/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#authHeader(),
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!response.ok) {
      throw await this.#streamHttpError(response);
    }

    if (!response.body) {
      throw new Error("No response body in stream");
    }

    return parseNDJSONStream(response.body, opts);
  }

  /**
   * Resume a chat after HITL interrupt.
   * Returns the same async iterable of stream events as `streamAgentChat`.
   *
   * `approved` translates to `{"approved": true|false}` on the wire, which
   * the server normalizes into a LangGraph `Command(resume=...)` decision
   * list (see chat_service.py::_normalize_resume_input).
   */
  async streamAgentResume(
    threadId: string,
    approved: boolean,
    opts: StreamCallOptions = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    const response = await fetch(`${this.#baseUrl}/api/chat/thread/${threadId}/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#authHeader(),
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify({ approved }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!response.ok) {
      throw await this.#streamHttpError(response);
    }

    if (!response.body) {
      throw new Error("No response body in stream");
    }

    return parseNDJSONStream(response.body, opts);
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  #authHeader(): Record<string, string> {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  /**
   * Normalize a non-2xx streaming response into a `StreamHttpError`.
   *
   * The server replies with a JSON `{detail: "..."}` body for both auth
   * failures (401) and chat-level rejections (e.g. invalid agent_config_id
   * → 400). On connection/setup errors the streaming endpoint may also
   * surface an `error` chunk *inside* the 200 stream — that's handled by
   * the caller via `StreamServerError`, not here.
   */
  async #streamHttpError(res: Response): Promise<StreamHttpError> {
    let detail = "";
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = (body.detail as string) ?? (body.message as string) ?? "";
    } catch {
      /* non-JSON body — fall back to status text */
    }
    return new StreamHttpError(res.status, detail || res.statusText);
  }

  /**
   * Normalize a non-2xx response into an Error carrying the parsed `detail`.
   *
   * Streaming endpoints raise `StreamHttpError` (subclass of Error with
   * `.status`/`.detail`); plain JSON endpoints raise a generic `Error` with
   * the detail string as the message — matching the historical behavior the
   * frontend already catches on.
   */
  async #httpError(res: Response): Promise<Error> {
    let detail = "";
    try {
      const body = (await res.json()) as Record<string, unknown>;
      detail = (body.detail as string) ?? (body.message as string) ?? "";
    } catch {
      /* non-JSON body — fall back to status text */
    }
    return new Error(detail || `${res.status}`);
  }

  async #get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      headers: this.#authHeader(),
    });
    if (!res.ok) throw await this.#httpError(res);
    return res.json() as T;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.#httpError(res);
    return res.json() as T;
  }

  async #put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...this.#authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.#httpError(res);
    return res.json() as T;
  }

  async #delete(path: string): Promise<void> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      headers: this.#authHeader(),
    });
    if (!res.ok) throw await this.#httpError(res);
  }
}
