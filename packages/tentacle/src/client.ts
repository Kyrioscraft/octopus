import { parseNDJSONStream } from "./stream.js";
import {
  StreamHttpError,
  type ChatRequest,
  type FirstRunResponse,
  type GeneralSettingsResponse,
  type GeneralTools,
  type InitRequest,
  type LoginRequest,
  type LoginResponse,
  type McpServerEntry,
  type McpWriteRequest,
  type ModelProviderDetail,
  type ModelProviderEntry,
  type ModelProviderPatch,
  type ModelSettingsResponse,
  type RemoteModel,
  type ResumeRequestBody,
  type SkillDetail,
  type SkillEntry,
  type SkillWriteRequest,
  type SlashCommandEntry,
  type SlashCommandWriteRequest,
  type StreamCallOptions,
  type StreamEvent,
  type SubagentEntry,
  type SubagentWriteRequest,
  type Thread,
  type ThreadListResponse,
  type ThreadHistoryResponse,
  type ThreadSnapshotResponse,
  type User,
  type Workspace,
  type WorkspaceEntry,
  type WorkspaceFileContent,
  type WorkspaceListResponse,
  type WorkspaceTreeResponse,
  type WorkspaceUploadResult,
  type ChatAttachmentUploadResult,
  type WorkspaceWriteRequest,
  type HostBrowseResult,
  type SandboxSettings,
  type SandboxSettingsPatch,
} from "./types.js";

// =============================================================================
// OctopusClient — typed HTTP client for the Octopus server API.
// =============================================================================

export class OctopusClient {
  readonly #baseUrl: string;
  #token: string | null = null;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    // Default to same-origin (relative) so requests go through the dev proxy
    // (Vite: /api → 127.0.0.1:9876) and the production reverse proxy.
    // Pass an explicit baseUrl only for non-browser / cross-origin use.
    this.#baseUrl = opts.baseUrl?.replace(/\/$/, "") ?? "";
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
  /**
   * List threads for the current user. Pass a workspace scope to filter:
   *   - { workspaceId: "<id>" } → only that workspace's threads
   *   - { workspaceId: "unbound" } → only threads with no workspace
   *   - omitted → all threads
   */
  async listThreads(scope?: { workspaceId?: string }): Promise<Thread[]> {
    const qs = scope?.workspaceId ? `?workspace_id=${encodeURIComponent(scope.workspaceId)}` : "";
    const res = await this.#get<ThreadListResponse>(`/api/chat/threads${qs}`);
    return res.threads;
  }

  /** Get message history for a thread. */
  async getThreadHistory(threadId: string): Promise<ThreadHistoryResponse> {
    return this.#get<ThreadHistoryResponse>(`/api/chat/thread/${threadId}/history`);
  }

  /**
   * P1 snapshot hydration: the thread's durable events + authoritative
   * subscribe-after cursor (`maxSeq`) + trailing pending-ask, in one atomic
   * response. Render by feeding `events` through the same accumulator +
   * projection as live streaming, then subscribe to /events?after=maxSeq.
   */
  async getThreadSnapshot(threadId: string): Promise<ThreadSnapshotResponse> {
    return this.#get<ThreadSnapshotResponse>(`/api/chat/thread/${threadId}/messages`);
  }

  /** Delete a thread. */
  async deleteThread(threadId: string): Promise<void> {
    await this.#delete(`/api/chat/thread/${threadId}`);
  }

  /** Rename a thread. */
  async renameThread(threadId: string, title: string): Promise<void> {
    await this.#put(`/api/chat/thread/${threadId}`, { title });
  }

  /**
   * Switch the primary agent of an existing thread (plan/confirm/auto/full)
   * without sending a new message. The agent is persisted server-side so the
   * next resume honors it — this is how a mid-run switch takes effect at the
   * next approval point. Returns the stored agent name on success.
   *
   * The agent is the successor of the removed access-mode mechanism.
   */
  async setThreadAgent(
    threadId: string,
    agent: "plan" | "confirm" | "auto" | "full",
  ): Promise<string> {
    const res = await this.#patch<{ agent: string }>(
      `/api/chat/thread/${threadId}/agent`,
      { agent },
    );
    return res.agent;
  }

  // =========================================================================
  // Config — Skills (/api/config/skills)
  // =========================================================================

  /** List all skill entries (builtin + file + user-defined, merged). */
  async listSkills(): Promise<SkillEntry[]> {
    const res = await this.#get<{ skills: SkillEntry[] }>("/api/config/skills");
    return res.skills;
  }

  /** Get a single skill's detail (content + origin). */
  async getSkill(name: string): Promise<SkillDetail> {
    return this.#get<SkillDetail>(`/api/config/skills/${encodeURIComponent(name)}`);
  }

  /** Create a user-defined skill. */
  async createSkill(body: SkillWriteRequest): Promise<SkillEntry> {
    const res = await this.#post<{ skill: SkillEntry }>("/api/config/skills", body);
    return res.skill;
  }

  /** Update a user-defined skill (partial). */
  async updateSkill(name: string, body: SkillWriteRequest): Promise<SkillEntry> {
    const res = await this.#put<{ skill: SkillEntry }>(
      `/api/config/skills/${encodeURIComponent(name)}`,
      body,
    );
    return res.skill;
  }

  /** Delete a user-defined skill. */
  async deleteSkill(name: string): Promise<void> {
    await this.#delete(`/api/config/skills/${encodeURIComponent(name)}`);
  }

  /** Import a skill from an uploaded .zip or .md file (multipart). */
  async importSkill(file: File): Promise<SkillEntry> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${this.#baseUrl}/api/config/skills/import`, {
      method: "POST",
      headers: this.#authHeader(),
      body: formData,
    });
    if (!res.ok) throw await this.#httpError(res);
    const data = (await res.json()) as { skill: SkillEntry };
    return data.skill;
  }

  /** Install a builtin skill (creates an editable user-defined copy). */
  async installBuiltinSkill(name: string): Promise<SkillEntry> {
    const res = await this.#post<{ skill: SkillEntry }>(
      `/api/config/skills/${encodeURIComponent(name)}/install`,
      {},
    );
    return res.skill;
  }

  // =========================================================================
  // Config — MCP servers (/api/config/mcp)
  // =========================================================================

  /**
   * List all MCP server entries (file + user-defined, merged). Pass
   * `probe=true` to populate connection `status`/`error` per server
   * (slower — actually connects to each server).
   */
  async listMcp(probe = false): Promise<McpServerEntry[]> {
    const res = await this.#get<{ servers: McpServerEntry[] }>(
      `/api/config/mcp${probe ? "?probe=true" : ""}`,
    );
    return res.servers;
  }

  /** Get a single MCP server's detail. */
  async getMcp(name: string): Promise<McpServerEntry> {
    return this.#get<McpServerEntry>(`/api/config/mcp/${encodeURIComponent(name)}`);
  }

  /** Create a user-defined MCP server. */
  async createMcp(body: McpWriteRequest): Promise<McpServerEntry> {
    const res = await this.#post<{ server: McpServerEntry }>("/api/config/mcp", body);
    return res.server;
  }

  /** Update a user-defined MCP server (partial). */
  async updateMcp(name: string, body: McpWriteRequest): Promise<McpServerEntry> {
    const res = await this.#put<{ server: McpServerEntry }>(
      `/api/config/mcp/${encodeURIComponent(name)}`,
      body,
    );
    return res.server;
  }

  /** Delete a user-defined MCP server. */
  async deleteMcp(name: string): Promise<void> {
    await this.#delete(`/api/config/mcp/${encodeURIComponent(name)}`);
  }

  /** Enable/disable an MCP server at runtime (works for any origin). */
  async setMcpEnabled(name: string, enabled: boolean): Promise<boolean> {
    const res = await this.#put<{ success: boolean; enabled: boolean }>(
      `/api/config/mcp/${encodeURIComponent(name)}/enabled`,
      { enabled },
    );
    return res.enabled;
  }

  // =========================================================================
  // Config — Subagents (/api/config/subagents)
  // =========================================================================

  /** List all subagent entries (file + user-defined, merged). */
  async listSubagents(): Promise<SubagentEntry[]> {
    const res = await this.#get<{ subagents: SubagentEntry[] }>(
      "/api/config/subagents",
    );
    return res.subagents;
  }

  /** Get a single subagent's detail. */
  async getSubagent(name: string): Promise<SubagentEntry> {
    return this.#get<SubagentEntry>(`/api/config/subagents/${encodeURIComponent(name)}`);
  }

  /** Create a user-defined subagent. */
  async createSubagent(body: SubagentWriteRequest): Promise<SubagentEntry> {
    const res = await this.#post<{ subagent: SubagentEntry }>(
      "/api/config/subagents",
      body,
    );
    return res.subagent;
  }

  /** Update a user-defined subagent (partial). */
  async updateSubagent(name: string, body: SubagentWriteRequest): Promise<SubagentEntry> {
    const res = await this.#put<{ subagent: SubagentEntry }>(
      `/api/config/subagents/${encodeURIComponent(name)}`,
      body,
    );
    return res.subagent;
  }

  /** Delete a user-defined subagent. */
  async deleteSubagent(name: string): Promise<void> {
    await this.#delete(`/api/config/subagents/${encodeURIComponent(name)}`);
  }

  /** Enable/disable a user-defined subagent at runtime. */
  async setSubagentEnabled(name: string, enabled: boolean): Promise<boolean> {
    const res = await this.#put<{ success: boolean; enabled: boolean }>(
      `/api/config/subagents/${encodeURIComponent(name)}/enabled`,
      { enabled },
    );
    return res.enabled;
  }

  // =========================================================================
  // Settings — model providers + general (/api/config/models, /api/config/settings)
  // =========================================================================

  /** List all model providers with the current default model. */
  async listModelSettings(): Promise<ModelSettingsResponse> {
    return this.#get<ModelSettingsResponse>("/api/config/models");
  }

  /** Get a single provider's detail (includes hasApiKeyLiteral). */
  async getModelProvider(name: string): Promise<ModelProviderDetail> {
    return this.#get<ModelProviderDetail>(`/api/config/models/${encodeURIComponent(name)}`);
  }

  /** Set the default model spec (`provider:model`). */
  async setDefaultModel(spec: string): Promise<string> {
    const res = await this.#put<{ default_model: string }>(
      "/api/config/models/default",
      { default_model: spec },
    );
    return res.default_model;
  }

  /** Patch a provider's config (api key, base url, models, enabled). */
  async updateModelProvider(name: string, patch: ModelProviderPatch): Promise<ModelProviderEntry> {
    const res = await this.#put<{ provider: ModelProviderEntry }>(
      `/api/config/models/${encodeURIComponent(name)}`,
      patch,
    );
    return res.provider;
  }

  /** Enable/disable a provider. */
  async setModelProviderEnabled(name: string, enabled: boolean): Promise<boolean> {
    const res = await this.#put<{ enabled: boolean }>(
      `/api/config/models/${encodeURIComponent(name)}/enabled`,
      { enabled },
    );
    return res.enabled;
  }

  /** Fetch a provider's live model list (no persistence). */
  async fetchRemoteModels(name: string): Promise<RemoteModel[]> {
    const res = await this.#get<{ models: RemoteModel[] }>(
      `/api/config/models/${encodeURIComponent(name)}/remote`,
    );
    return res.models;
  }

  /** Fetch general settings (persisted + effective tool toggles + system info). */
  async getGeneralSettings(): Promise<GeneralSettingsResponse> {
    return this.#get<GeneralSettingsResponse>("/api/config/settings");
  }

  /** Update persisted general tool toggles. */
  async updateGeneralSettings(tools: GeneralTools): Promise<GeneralSettingsResponse> {
    return this.#put<GeneralSettingsResponse>("/api/config/settings", tools);
  }

  // --- Sandbox settings (config.json `sandbox` section) ---

  /** Get sandbox backend configuration (credentials are write-only). */
  async getSandboxSettings(): Promise<SandboxSettings> {
    return this.#get<SandboxSettings>("/api/config/sandbox");
  }

  /** Update sandbox configuration. `apiKey` is write-only. */
  async updateSandboxSettings(patch: SandboxSettingsPatch): Promise<SandboxSettings> {
    return this.#put<SandboxSettings>("/api/config/sandbox", patch);
  }

  // =========================================================================
  // Config — Slash commands (/api/config/slash-commands)
  // =========================================================================

  /** List all slash commands (builtin + user-defined, merged). */
  async listSlashCommands(platform?: "web" | "tui" | "all"): Promise<SlashCommandEntry[]> {
    const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
    const res = await this.#get<{ commands: SlashCommandEntry[] }>(
      `/api/config/slash-commands${qs}`,
    );
    return res.commands;
  }

  /** Get a single slash command's detail. */
  async getSlashCommand(id: string): Promise<SlashCommandEntry> {
    return this.#get<SlashCommandEntry>(
      `/api/config/slash-commands/${encodeURIComponent(id)}`,
    );
  }

  /** Create a user-defined slash command. */
  async createSlashCommand(body: SlashCommandWriteRequest): Promise<SlashCommandEntry> {
    const res = await this.#post<{ command: SlashCommandEntry }>(
      "/api/config/slash-commands",
      body,
    );
    return res.command;
  }

  /** Update a user-defined slash command (partial). */
  async updateSlashCommand(id: string, body: SlashCommandWriteRequest): Promise<SlashCommandEntry> {
    const res = await this.#put<{ command: SlashCommandEntry }>(
      `/api/config/slash-commands/${encodeURIComponent(id)}`,
      body,
    );
    return res.command;
  }

  /** Delete a user-defined slash command. */
  async deleteSlashCommand(id: string): Promise<void> {
    await this.#delete(`/api/config/slash-commands/${encodeURIComponent(id)}`);
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
   * Start a new chat turn (subscription model).
   *
   * POST /agent only STARTS the server-side run and returns immediately with
   * `{threadId, requestId}` (202). The turn's events are observed by
   * subscribing via `streamThreadEvents(threadId, after)` — which replays
   * durable events from `after` then tails live. Multiple clients can
   * subscribe to the same thread independently.
   */
  async startTurn(body: ChatRequest): Promise<{ threadId: string; requestId: string }> {
    const response = await fetch(`${this.#baseUrl}/api/chat/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await this.#streamHttpError(response);
    }
    return response.json();
  }

  /**
   * Convenience composition: start a turn, then subscribe to its events.
   * Defaults to a full replay (after=0) for a fresh client; callers that
   * already rendered earlier turns of the thread pass their last-seen seq so
   * only the new turn's events stream in (otherwise the whole thread would
   * replay into the new turn's bubble).
   */
  async streamAgentChat(
    body: ChatRequest,
    opts: StreamCallOptions & { after?: number } = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    const { after = 0, ...streamOpts } = opts;
    const { threadId } = await this.startTurn(body);
    return this.streamThreadEvents(threadId, after, streamOpts);
  }

  /**
   * Resume a paused (HITL) turn (subscription model): starts the server-side
   * resume run and returns immediately; observe via `streamThreadEvents`.
   *
   * Sends a structured resume body. New callers should pass a
   * `ResumeRequestBody` (with `kind` + `decisions`/`answers`); the legacy
   * `streamAgentResumeLegacy(threadId, approved)` wrapper below preserves the
   * old `{approved: boolean}` shape for gradual migration.
   *
   * The server normalizes the body into a LangGraph `Command(resume=...)`
   * value (see chat.service.ts::normalizeResumeInput).
   */
  async resumeTurn(
    threadId: string,
    body: ResumeRequestBody,
  ): Promise<{ threadId: string; requestId: string }> {
    const response = await fetch(`${this.#baseUrl}/api/chat/thread/${threadId}/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await this.#streamHttpError(response);
    }
    return response.json();
  }

  /**
   * Convenience composition: start the resume, then subscribe AFTER the events
   * the caller has already consumed (default 0 = full replay). Pass the last
   * seen seq to continue a turn that paused at an ask without re-consuming
   * the pre-ask timeline (which would duplicate tool/text blocks and re-pop
   * the ask panel).
   */
  async streamAgentResume(
    threadId: string,
    body: ResumeRequestBody,
    opts: StreamCallOptions & { after?: number } = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    const { after = 0, ...streamOpts } = opts;
    await this.resumeTurn(threadId, body);
    return this.streamThreadEvents(threadId, after, streamOpts);
  }

  /**
   * Legacy resume wrapper — the pre-unification API took a single boolean.
   * Kept for gradual migration; new code should call `streamAgentResume`
   * with a full `ResumeRequestBody`.
   */
  async streamAgentResumeLegacy(
    threadId: string,
    approved: boolean,
    opts?: StreamCallOptions
  ): Promise<AsyncGenerator<StreamEvent>> {
    return this.streamAgentResume(threadId, { approved, kind: "tool_approval" }, opts ?? {});
  }

  /**
   * Re-attach to a running thread's NDJSON event stream (GET /events).
   *
   * Replays buffered events with seq > `after`, then tails live events until
   * the run finishes (a terminal `finished`/`error`/`interrupted`/`idle`
   * chunk). Use after navigating back into a thread whose run is executing in
   * the background. `heartbeat` chunks are keepalives — ignore them.
   */
  async streamThreadEvents(
    threadId: string,
    after = 0,
    opts: StreamCallOptions = {}
  ): Promise<AsyncGenerator<StreamEvent>> {
    const response = await fetch(
      `${this.#baseUrl}/api/chat/thread/${threadId}/events?after=${after}`,
      {
        headers: {
          ...this.#authHeader(),
          Accept: "application/x-ndjson",
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
      }
    );

    if (!response.ok) {
      throw await this.#streamHttpError(response);
    }

    if (!response.body) {
      throw new Error("No response body in stream");
    }

    return parseNDJSONStream(response.body, opts);
  }

  /**
   * Explicitly stop a thread's background run (POST /stop).
   *
   * With runs decoupled from connections, aborting the fetch no longer stops
   * the run — the server aborts its registry AbortController, saves partial
   * output, and emits `interrupted` to attached listeners.
   */
  async stopThreadRun(threadId: string): Promise<void> {
    await this.#post(`/api/chat/thread/${threadId}/stop`, {});
  }

  // =========================================================================
  // Workspaces (/api/workspace) — filesystem-backed, DB-tracked directories
  // =========================================================================

  /** List all workspaces for the current user. */
  async listWorkspaces(): Promise<Workspace[]> {
    const res = await this.#get<WorkspaceListResponse>("/api/workspace");
    return res.workspaces;
  }

  /**
   * Browse host directories for the 本机目录 picker. Pass an absolute path to
   * list its subdirectories; omit to list the first browsable root. Returns the
   * listed path, its subdirs, and the configured browsable roots.
   */
  async browseHostDirs(path?: string): Promise<HostBrowseResult> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.#get<HostBrowseResult>(`/api/workspace/browse${qs}`);
  }

  /** Create a new workspace. */
  async createWorkspace(body: WorkspaceWriteRequest): Promise<Workspace> {
    const res = await this.#post<{ workspace: Workspace }>("/api/workspace", body);
    return res.workspace;
  }

  /**
   * Open (or reopen) a host directory as a workspace — the IDE-style "Open
   * Folder" action. Dedupes by path (reuses an existing row) and bumps its
   * last-opened timestamp. Returns the bound workspace.
   */
  async openWorkspace(path: string): Promise<Workspace> {
    const res = await this.#post<{ workspace: Workspace }>("/api/workspace/open", { path });
    return res.workspace;
  }

  /** Get a single workspace's detail. */
  async getWorkspace(id: string): Promise<Workspace> {
    const res = await this.#get<{ workspace: Workspace }>(
      `/api/workspace/${encodeURIComponent(id)}`,
    );
    return res.workspace;
  }

  /** Update a workspace (name/description). */
  async updateWorkspace(id: string, body: WorkspaceWriteRequest): Promise<Workspace> {
    const res = await this.#put<{ workspace: Workspace }>(
      `/api/workspace/${encodeURIComponent(id)}`,
      body,
    );
    return res.workspace;
  }

  /** Delete a workspace (threads are kept, their binding is cleared). */
  async deleteWorkspace(id: string): Promise<void> {
    await this.#delete(`/api/workspace/${encodeURIComponent(id)}`);
  }

  /** List a directory inside a workspace. */
  async getWorkspaceTree(
    id: string,
    path?: string,
    recursive = false,
  ): Promise<WorkspaceEntry[]> {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (recursive) params.set("recursive", "true");
    const qs = params.toString();
    const res = await this.#get<WorkspaceTreeResponse>(
      `/api/workspace/${encodeURIComponent(id)}/tree${qs ? `?${qs}` : ""}`,
    );
    return res.entries;
  }

  /** Read a file's content + preview type. */
  async getWorkspaceFile(id: string, path: string): Promise<WorkspaceFileContent> {
    const qs = new URLSearchParams({ path });
    return this.#get<WorkspaceFileContent>(
      `/api/workspace/${encodeURIComponent(id)}/file?${qs}`,
    );
  }

  /** Write (create/overwrite) an editable file (.md/.markdown/.mdx/.txt). */
  async saveWorkspaceFile(
    id: string,
    path: string,
    content: string,
  ): Promise<{ path: string }> {
    return this.#put<{ path: string }>(
      `/api/workspace/${encodeURIComponent(id)}/file`,
      { path, content },
    );
  }

  /** Delete a file or directory inside a workspace. */
  async deleteWorkspacePath(id: string, path: string): Promise<void> {
    const qs = new URLSearchParams({ path });
    await this.#delete(`/api/workspace/${encodeURIComponent(id)}/file?${qs}`);
  }

  /** Create a directory inside a workspace. */
  async createWorkspaceDirectory(
    id: string,
    name: string,
    parentPath?: string,
  ): Promise<{ path: string }> {
    return this.#post<{ path: string }>(
      `/api/workspace/${encodeURIComponent(id)}/directory`,
      { name, parentPath },
    );
  }

  /** Download a file as a Blob (used for image/pdf preview). */
  async downloadWorkspaceFile(id: string, path: string): Promise<Blob> {
    const qs = new URLSearchParams({ path });
    const res = await fetch(
      `${this.#baseUrl}/api/workspace/${encodeURIComponent(id)}/download?${qs}`,
      { headers: this.#authHeader() },
    );
    if (!res.ok) throw await this.#httpError(res);
    return res.blob();
  }

  /** Upload a single file into a workspace (multipart). */
  async uploadWorkspaceFile(
    id: string,
    file: File,
    parentPath?: string,
  ): Promise<WorkspaceUploadResult> {
    const formData = new FormData();
    formData.append("file", file);
    if (parentPath !== undefined) formData.append("parentPath", parentPath);
    const res = await fetch(
      `${this.#baseUrl}/api/workspace/${encodeURIComponent(id)}/upload`,
      {
        method: "POST",
        headers: this.#authHeader(),
        body: formData,
      },
    );
    if (!res.ok) throw await this.#httpError(res);
    return res.json() as Promise<WorkspaceUploadResult>;
  }

  /** Upload a chat attachment into a workspace's attachments/ area. Omit
   * `workspaceId` to let the server resolve the user's default workspace
   * (matches how POST /api/chat/agent binds threads). */
  async uploadChatAttachment(
    file: File,
    workspaceId?: string,
  ): Promise<ChatAttachmentUploadResult> {
    const formData = new FormData();
    formData.append("file", file);
    if (workspaceId !== undefined) formData.append("workspace_id", workspaceId);
    const res = await fetch(`${this.#baseUrl}/api/chat/attachments`, {
      method: "POST",
      headers: this.#authHeader(),
      body: formData,
    });
    if (!res.ok) throw await this.#httpError(res);
    return res.json() as Promise<ChatAttachmentUploadResult>;
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
   * failures (401) and chat-level rejections (e.g. invalid agent_id
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

  async #patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method: "PATCH",
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
