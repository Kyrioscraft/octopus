// =============================================================================
// TUI client — thin wrapper around OctopusClient for TUI-specific needs.
//
// Equivalent to Python tui.remote_client (RemoteAgent), but much simpler since
// the TypeScript server uses NDJSON over HTTP instead of LangGraph's SSE.
// =============================================================================

import { OctopusClient, StreamHttpError, StreamServerError } from "@octopus/tentacle";
import type { ChatRequest, StreamCallOptions, StreamEvent, Thread } from "@octopus/tentacle";
import { getLogger } from "./logging.js";

const logger = getLogger("tui.client");

export { StreamHttpError, StreamServerError };
export type { StreamEvent, Thread };

// =============================================================================
// TuiClient — extends OctopusClient with TUI-specific convenience methods
// =============================================================================

export class TuiClient {
  readonly #client: OctopusClient;
  /** Server base URL, retained for the raw health probe (see checkHealth). */
  readonly #baseUrl: string;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    this.#client = new OctopusClient(opts);
    this.#baseUrl = opts.baseUrl?.replace(/\/$/, "") ?? "";
  }

  get client(): OctopusClient {
    return this.#client;
  }

  setToken(t: string | null): void {
    this.#client.setToken(t);
  }

  // ---------------------------------------------------------------------------
  // Server health
  // ---------------------------------------------------------------------------

  /**
   * Check if the server is reachable.
   *
   * Probes the auth-agnostic, DB-free `/api/system/health` endpoint rather
   * than `/api/auth/check-first-run`, because the TUI boots as an anonymous
   * user and should not depend on auth or first-run state to determine
   * readiness — only on whether the server is answering HTTP.
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = this.#baseUrl + "/api/system/health";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return { ok: res.status < 500 };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      logger.exception("checkHealth failed", err);
      return { ok: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // Thread management
  // ---------------------------------------------------------------------------

  /** List all threads for the current user. */
  async listThreads(): Promise<Thread[]> {
    return this.#client.listThreads();
  }

  /** Get history for a specific thread. */
  async getThreadHistory(threadId: string): Promise<{ history: { id: string; role: string; content: string; createdAt: string }[] }> {
    return this.#client.getThreadHistory(threadId);
  }

  /** Delete a thread. */
  async deleteThread(threadId: string): Promise<void> {
    return this.#client.deleteThread(threadId);
  }

  // ---------------------------------------------------------------------------
  // Chat streaming
  // ---------------------------------------------------------------------------

  /**
   * Send a chat message and receive an async iterable of stream events.
   *
   * Usage:
   * ```ts
   * const stream = client.streamChat({ messages: [...], thread_id: "..." });
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "loading": console.log(event.response); break;
   *     case "finished": console.log("done"); break;
   *   }
   * }
   * ```
   */
  async streamChat(
    body: ChatRequest,
    opts: StreamCallOptions = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    return this.#client.streamAgentChat(body, opts);
  }

  /**
   * Resume a chat after HITL interrupt.
   */
  async streamResume(
    threadId: string,
    approved: boolean,
    opts: StreamCallOptions = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    return this.#client.streamAgentResume(threadId, approved, opts);
  }
}
