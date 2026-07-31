/**
 * Agent graph factory — compile LangGraph graphs from ServerConfig.
 *
 * Equivalent to Python `cortex.server_graph.make_graph()` +
 * `cortex.server_graph._build_chat_model()` +
 * `cortex.agent.create_cli_agent()` (middleware stack, HITL, backend).
 *
 * Key features:
 *   - Model construction with config.toml params / base_url / api_key
 *   - Provider override support (web DB overrides > config.toml)
 *   - Built-in tools (fetch_url, web_search) wired via StructuredTool
 *   - MCP tool loading (reserved interface)
 *   - Full HITL interrupt configuration
 *   - CompositeBackend with temp-directory routing
 *   - Middleware stack: FilesystemEmptyResult → ToolExceptionRecovery →
 *     ResumeState → ShellAllowList → Summarization
 *   - System prompt generation (interactive / headless modes)
 *   - Graph caching by signature key
 *   - Backward-compatible `createAgent` alias
 */

import { createDeepAgent } from "deepagents";
import { BUILTIN_SUBAGENTS } from "./built_in_subagents.js";
import { CompositeBackend, FilesystemBackend, LocalShellBackend, LangSmithSandbox } from "deepagents";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { type ServerConfig, type AccessMode, DESTRUCTIVE_TOOLS } from "./config.js";
import {
  ModelConfig,
  resolveEnvVar,
  getSandboxConfig,
  resolveSandboxApiKey,
  sandboxHasCredentials,
} from "./model_config.js";
import type { ProviderConfig } from "./model_config.js";
import { getLogger } from "./logging.js";
import { getSystemPrompt, buildModelIdentitySection } from "./prompts.js";
import { FilesystemEmptyResultMiddleware } from "./middleware/filesystem_empty_result.js";
import { BinaryContentSanitizerMiddleware } from "./middleware/binary_content_sanitizer.js";
import { FileEditGuardMiddleware } from "./middleware/file_edit_guard.js";
import { ToolExceptionRecoveryMiddleware } from "./middleware/tool_exception_recovery.js";
import { ResumeStateMiddleware } from "./middleware/resume_state.js";
import { ShellAllowListMiddleware } from "./middleware/shell_allow_list.js";
import { LocalContextMiddleware } from "./middleware/local_context.js";
import { ConfigurableModelMiddleware } from "./middleware/configurable_model.js";
import { getBuiltinToolsAsStructuredTools } from "./tools.js";
import { createAskUserQuestionTool } from "./tools/ask_user_question.js";
import { listSkills } from "./skills.js";
import { resolveAndLoadMcpTools } from "./mcp_tools.js";
import type { MCPServerInfo } from "./mcp_tools.js";
import { ProjectContext, findProjectRoot } from "./project_utils.js";
import { tmpdir, homedir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const logger = getLogger("agent.graph");

// =============================================================================
// Checkpointer — process-level singleton MemorySaver.
// =============================================================================

let _checkpointer: MemorySaver | null = null;

export function getCheckpointer(): MemorySaver {
  if (!_checkpointer) {
    _checkpointer = new MemorySaver();
  }
  return _checkpointer;
}

// =============================================================================
// Graph cache — keyed by (model, systemPrompt, tools, enableShell,
// enableWebSearch, mcpSignature).
// Equivalent to Python `agent_config_service._graph_cache`.
// =============================================================================

/**
 * A single entry in the subagent registry — describes a subagent that may be
 * invoked via the `task` tool. Surfaced to UIs so they can render the
 * subagent's system prompt alongside its activity.
 */
export interface SubagentRegistryEntry {
  name: string;
  description: string;
  systemPrompt: string;
  source: "user" | "project" | "user-defined" | "builtin";
}

/**
 * Result of compiling an agent graph. The `agent` is the compiled LangGraph
 * runnable; `subagentRegistry` lets callers (e.g. the server) look up the
 * system prompt for a given subagent type when it is invoked at runtime.
 */
export interface CompiledAgent {
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
}

/**
 * An external subagent spec injected by the server (file-source or user-defined).
 * core is DB-free, so the server discovers/merges these and passes the data in.
 * `source` is surfaced to the registry so the UI can label provenance.
 */
export interface ExternalSubagentSpec {
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool-name whitelist (empty/undefined = inherit all main-agent tools). */
  tools?: string[];
  /** Optional model override in 'provider:model-name' format. */
  model?: string | null;
  /** Runtime enabled flag — disabled subagents are filtered out by the caller. */
  enabled?: boolean;
  /** Provenance: 'file' (AGENTS.md) or 'user-defined' (DB). */
  source?: "file" | "user-defined";
}

const _graphCache = new Map<string, Promise<CompiledAgent>>();

export function clearGraphCache(): void {
  _graphCache.clear();
}

function _cacheKey(config: ServerConfig, mcpSignature?: string, subagentSignature?: string): string {
  return JSON.stringify([
    config.model,
    config.systemPrompt ?? "",
    (config.tools ?? []).sort(),
    config.enableShell,
    config.enableWebSearch,
    mcpSignature ?? "",
    subagentSignature ?? "",
  ]);
}

// =============================================================================
// Model construction — equivalent to Python `_build_chat_model()`.
// =============================================================================

interface BuildModelResult {
  model: any; // BaseChatModel
  provider: string;
  modelName: string;
}

/**
 * Build a LangChain chat model instance from a model spec and provider config.
 *
 * Reads `~/.deepagents/config.toml` for per-provider params / base_url /
 * api_key_env. Provider overrides (from web DB) take precedence over
 * config.toml values. API keys are resolved via `resolveEnvVar` for
 * `DEEPAGENTS_CODE_` prefix support.
 *
 * Merges modelParams from ServerConfig on top of config.toml params.
 *
 * Equivalent to Python `cortex.server_graph._build_chat_model()`.
 */
async function _buildChatModel(
  modelSpec: string,
  providerOverrides?: Record<string, { baseUrl?: string; apiKeyEnv?: string; apiKey?: string }>,
  modelParams?: Record<string, unknown>,
): Promise<BuildModelResult> {
  // Parse "provider:model"
  const colonIdx = modelSpec.indexOf(":");
  if (colonIdx <= 0) {
    throw new Error(
      `Invalid model spec "${modelSpec}" — must be in provider:model format`,
    );
  }
  const provider = modelSpec.slice(0, colonIdx);
  const modelName = modelSpec.slice(colonIdx + 1);

  // Read provider config from config.toml
  const config = ModelConfig.load();
  const providerConfig: ProviderConfig = config.providers[provider] ?? {};

  // Resolve params: config.toml base → modelParams override (modelParams wins)
  const params: Record<string, unknown> = {
    ...ModelConfig.getKwargs(provider, modelName),
    ...(modelParams ?? {}),
  };

  // Resolve base_url: providerOverride > config.toml > env var
  let baseUrl: string | undefined;
  const override = providerOverrides?.[provider];
  if (override?.baseUrl) {
    baseUrl = override.baseUrl;
  }
  if (!baseUrl) {
    baseUrl = ModelConfig.getBaseUrl(provider);
  }

  // Resolve API key: providerOverride (web DB) > config.json api_key > config.json api_key_env > env var
  let apiKey: string | undefined;
  if (override?.apiKey) {
    apiKey = override.apiKey;
  }
  if (!apiKey) {
    apiKey = ModelConfig.getApiKey(provider);
  }
  if (!apiKey) {
    logger.debug(
      `No API key configured for provider "${provider}". ` +
      "The model will fail at runtime if no key is available.",
    );
  }

  // Build the model instance
  let model: any;

  // Map provider to the appropriate LangChain chat model class.
  // Primary support: OpenAI + Anthropic. All other providers fall back to
  // ChatOpenAI with custom baseURL (OpenAI-compatible API pattern).
  switch (provider) {
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      model = new ChatAnthropic({
        model: modelName,
        streaming: true,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { clientOptions: { baseURL: baseUrl } } : {}),
      });
      // Apply known params individually (ChatAnthropic doesn't spread arbitrary params)
      if (params["temperature"] !== undefined) {
        (model as any).temperature = params["temperature"];
      }
      if (params["max_tokens"] !== undefined) {
        (model as any).maxTokens = params["max_tokens"];
      }
      break;
    }
    case "google_genai":
    case "google_vertexai": {
      // Google — use ChatOpenAI-compatible mode (Gemini API supports OpenAI spec via baseUrl)
      // For native Gemini SDK, install @langchain/google-genai separately.
      logger.debug(
        `Provider "${provider}" — using OpenAI-compatible mode. ` +
        "Install @langchain/google-genai for native Gemini SDK support.",
      );
      const { ChatOpenAI } = await import("@langchain/openai");
      model = new ChatOpenAI({
        model: modelName,
        streaming: true,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
        ...params,
      });
      break;
    }
    default: {
      // OpenAI + all OpenAI-compatible providers (deepseek, openrouter, together, xai,
      // groq, fireworks, perplexity, baseten, mistralai, nvidia, cohere, huggingface, etc.)
      const { ChatOpenAI } = await import("@langchain/openai");
      model = new ChatOpenAI({
        model: modelName,
        streaming: true,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
        ...params,
      });
    }
  }

  return { model, provider, modelName };
}

// =============================================================================
// HITL interrupt configuration.
// Equivalent to Python `_add_interrupt_on()`.
// =============================================================================

/** Whether compact_conversation requires HITL approval. */
const REQUIRE_COMPACT_TOOL_APPROVAL = true;

/**
 * Build the full HITL interrupt configuration mapping tool names to their
 * interrupt settings. Every tool that can have side effects or access
 * external resources is gated behind an approval prompt.
 *
 * Equivalent to Python `_add_interrupt_on()`.
 */
function _addInterruptOn(): Record<string, {
  allowedDecisions: string[];
  description?: string;
}> {
  const interruptMap: Record<string, {
    allowedDecisions: string[];
    description?: string;
  }> = {
    execute: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow shell command execution?",
    },
    write_file: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow file write?",
    },
    edit_file: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow file edit?",
    },
    web_search: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow web search?",
    },
    fetch_url: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow URL fetch?",
    },
    task: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow task delegation to subagent?",
    },
    start_async_task: {
      allowedDecisions: ["approve", "reject"],
      description: "Launch, update, or cancel a remote async subagent.",
    },
    update_async_task: {
      allowedDecisions: ["approve", "reject"],
      description: "Launch, update, or cancel a remote async subagent.",
    },
    cancel_async_task: {
      allowedDecisions: ["approve", "reject"],
      description: "Launch, update, or cancel a remote async subagent.",
    },
  };

  if (REQUIRE_COMPACT_TOOL_APPROVAL) {
    interruptMap["compact_conversation"] = {
      allowedDecisions: ["approve", "reject"],
      description:
        "Offloads older messages to backend storage and " +
        "replaces them with a summary, freeing context " +
        "window space. Recent messages are kept as-is. " +
        "Full history remains available for retrieval.",
    };
  }

  return interruptMap;
}

// =============================================================================
// makeGraph — the main graph factory.
// Equivalent to Python `cortex.server_graph.make_graph()`.
// =============================================================================

/**
 * Build a compiled LangGraph agent graph from a ServerConfig.
 *
 * Full pipeline:
 * 1. Resolve built-in tools (fetch_url always, web_search conditional)
 * 2. Build chat model via `_buildChatModel` (config.toml params + overrides)
 * 3. Load MCP tools (reserved interface)
 * 4. Build CompositeBackend with temp-directory routing
 * 5. Build middleware stack
 * 6. Generate system prompt (if not provided)
 * 7. Configure HITL interrupts
 * 8. Assemble and compile via `createDeepAgent`
 * 9. Cache by signature key
 *
 * Equivalent to Python `cortex.server_graph.make_graph()`.
 */
export async function makeGraph(
  config: ServerConfig,
  options?: {
    /** Path to an MCP config JSON file (e.g., data/.web-mcp.json). */
    mcpConfigPath?: string;
    /** Working directory for the agent. */
    cwd?: string;
    /** Workspace environment hint — "sandbox" selects the sandbox backend. */
    workspace?: { environment?: "local" | "sandbox" };
    /**
     * Workspace access mode. `plan` strips destructive tools from the
     * toolset (read-only); `confirm`/`auto` keep them (HITL gating is then
     * controlled at runtime via the server-injected context). Part of the
     * cache key so different modes compile separate graphs.
     */
    accessMode?: AccessMode;
    /**
     * External subagents (file-source + user-defined), already merged by the
     * server. core is a pure library with no DB access, so the server owns
     * discovery/merge and injects the result here. Built-in subagents
     * (Explore, general-purpose) are added by core itself — do not include
     * them in this list. Part of the cache key.
     */
    userSubagents?: ExternalSubagentSpec[];
  },
): Promise<CompiledAgent> {
  const mcpSignature = options?.mcpConfigPath ?? "";
  // Include workspace environment in the cache key so local vs sandbox graphs
  // are not reused for each other.
  const wsSignature = options?.workspace?.environment === "sandbox" ? ":sandbox" : "";
  // accessMode changes the toolset (plan removes destructive tools), so it
  // must distinguish cache entries — otherwise a confirm-compiled graph would
  // be wrongly reused for a plan request.
  const modeSignature = options?.accessMode ?? "confirm";
  // Subagent shape (names + tool whitelists + model + enabled) affects the
  // compiled graph, so it must be part of the cache key — otherwise graphs
  // compiled for different user subagent configs would be wrongly reused.
  const subagentSignature = (options?.userSubagents ?? [])
    .map((s) => `${s.name}:${(s.tools ?? []).slice().sort().join(",")}:${s.model ?? ""}:${s.enabled ?? true}`)
    .sort()
    .join("|");
  const key = _cacheKey(config, mcpSignature, subagentSignature) + wsSignature + ":" + modeSignature;

  // Return cached graph if available
  const cached = _graphCache.get(key);
  if (cached) return cached;

  const promise = _makeGraphUncached(config, options);
  _graphCache.set(key, promise);

  // Remove failed builds from cache so retries work
  promise.catch(() => {
    _graphCache.delete(key);
  });

  return promise;
}

async function _makeGraphUncached(
  config: ServerConfig,
  options?: {
    mcpConfigPath?: string;
    cwd?: string;
    /**
     * Workspace environment hint. When `"sandbox"`, the backend is built from
     * the configured sandbox provider (LangSmith) instead of the local host
     * directory. Falls back to local if sandbox is unconfigured/failed.
     */
    workspace?: { environment?: "local" | "sandbox" };
    /** Access mode — `plan` strips destructive tools. See makeGraph. */
    accessMode?: AccessMode;
    /** External subagents (file + user-defined), injected by the server. */
    userSubagents?: ExternalSubagentSpec[];
  },
): Promise<CompiledAgent> {
  const cwd = options?.cwd ?? process.cwd();

  // ---- 0. Build ProjectContext ----
  const projectContext = ProjectContext.fromUserCwd(cwd);

  // ---- 1. Build the chat model (with config.toml params, provider overrides, modelParams) ----
  const { model, provider, modelName } = await _buildChatModel(
    config.model,
    config.providerOverrides,
    config.modelParams,
  );

  // ---- 2. Resolve built-in tools ----
  // fetch_url always included; web_search only when enableWebSearch is true.
  // ask_user_question is only available in interactive mode — under
  // autoApprove the agent should decide autonomously rather than ask.
  const allBuiltinTools = await getBuiltinToolsAsStructuredTools();
  const tools: any[] = allBuiltinTools.filter(
    (t: any) => t.name !== "web_search" || config.enableWebSearch,
  );
  if (config.interactive && !config.autoApprove) {
    tools.push(createAskUserQuestionTool());
  }

  // ---- 3. Load MCP tools ----
  let mcpToolsCount = 0;
  let mcpServerInfos: MCPServerInfo[] = [];
  const mcpConfigPath = options?.mcpConfigPath;
  if (config.mcpServers.length > 0 || mcpConfigPath) {
    try {
      const result = await resolveAndLoadMcpTools({
        explicitConfigPath: mcpConfigPath,
        projectRoot: projectContext.projectRoot ?? undefined,
      });
      if (result.tools.length > 0) {
        tools.push(...result.tools);
        mcpToolsCount = result.tools.length;
        mcpServerInfos = result.serverInfos;
        logger.info(`Loaded ${mcpToolsCount} MCP tool(s) from ${result.serverInfos.length} server(s)`);
      }
    } catch (err) {
      logger.warn(`Failed to load MCP tools: ${String(err)}`);
    }
  }

  // ---- 3b. plan mode — strip destructive tools (read-only enforcement) ----
  // Done AFTER MCP loading so MCP-registered destructive tools are also removed.
  // plan mode means the agent may only research/plan: it cannot write, edit,
  // execute, delegate, or compact. The toolset reduction is what makes the
  // mode enforceable (vs. relying on prompt guidance alone).
  if (options?.accessMode === "plan") {
    const before = tools.length;
    for (let i = tools.length - 1; i >= 0; i--) {
      if (DESTRUCTIVE_TOOLS.has(tools[i].name)) tools.splice(i, 1);
    }
    logger.info(
      `plan mode: removed ${before - tools.length} destructive tool(s) ` +
      `(built-in + MCP); ${tools.length} read-only tool(s) remain`,
    );
  }

  // ---- 4. Build CompositeBackend with temp-directory routing ----
  // Matching Python: local mode uses CompositeBackend with routes for
  // /large_tool_results/ and /conversation_history/ to temp directories.
  //
  // Workspace environment drives the primary backend: "sandbox" tries to build
  // a LangSmith sandbox (falls back to local if unconfigured/fails); otherwise
  // a local host backend rooted at `cwd`.
  let backend: any;
  const useSandbox = options?.workspace?.environment === "sandbox";
  let sandboxBuilt = false;
  if (useSandbox) {
    try {
      const sbCfg = getSandboxConfig();
      const apiKey = resolveSandboxApiKey(sbCfg);
      if (sbCfg.enabled !== false && sandboxHasCredentials(sbCfg)) {
        logger.info("Building LangSmith sandbox backend");
        backend = await LangSmithSandbox.create({
          ...(apiKey ? { apiKey } : {}),
          ...(sbCfg.template_name ? { templateName: sbCfg.template_name } : {}),
          ...(sbCfg.snapshot_id ? { snapshotId: sbCfg.snapshot_id } : {}),
        });
        sandboxBuilt = true;
      } else {
        logger.warn("Sandbox workspace requested but sandbox not configured; falling back to local");
      }
    } catch (err) {
      logger.exception("Failed to build sandbox backend; falling back to local", err as Error);
    }
  }
  if (!sandboxBuilt) {
    if (config.enableShell) {
      backend = new LocalShellBackend({
        rootDir: cwd,
        inheritEnv: true,
        env: process.env as Record<string, string>,
      });
    } else {
      backend = new FilesystemBackend({ rootDir: cwd, virtualMode: false });
    }
  }

  const largeResultsBackend = new FilesystemBackend({
    rootDir: mkdtempSync(join(tmpdir(), "deepagents_large_results_")),
    virtualMode: true,
  });
  const conversationHistoryBackend = new FilesystemBackend({
    rootDir: mkdtempSync(join(tmpdir(), "deepagents_conversation_history_")),
    virtualMode: true,
  });

  const compositeBackend = new CompositeBackend(backend, {
    "/large_tool_results/": largeResultsBackend,
    "/conversation_history/": conversationHistoryBackend,
  });

  // ---- 5. Build middleware stack ----
  // Order matches Python create_cli_agent:
  // ConfigurableModel → FilesystemEmptyResult → ToolExceptionRecovery →
  // ResumeState → LocalContext → [ShellAllowList] → Summarization
  const middleware: any[] = [];

  // ConfigurableModel is outermost — intercepts every model call before
  // provider-specific middleware runs. Allows runtime model swapping via
  // runtime.context. Uses buildChatModel (same resolution as the main graph).
  middleware.push(new ConfigurableModelMiddleware(
    (spec: string) => buildChatModel(spec, config.providerOverrides),
  ));

  // Always-on middleware
  middleware.push(new FilesystemEmptyResultMiddleware());
  // BinaryContentSanitizer runs early (before ToolExceptionRecovery) so that
  // `read_file` results carrying `type:"file"` / `image` / `audio` / `video`
  // blocks are rewritten to text *before* the ToolMessage reaches the graph's
  // messages channel. The LangGraph Rust checkpointer can only deserialize
  // `text` / `image_url` content — anything else crashes on the next turn.
  middleware.push(new BinaryContentSanitizerMiddleware());
  // FileEditGuard intercepts `execute` calls that do file writes (sed -i,
  // echo >, tee, etc.) and redirects the model to edit_file/write_file.
  // Non-Anthropic models often ignore the prompt's tool-usage guidance; this
  // enforces it programmatically so file edits always go through
  // FilesystemBackend.edit()/write() (safe string replacement) instead of
  // shell commands (which also trigger excessive HITL approval prompts).
  middleware.push(new FileEditGuardMiddleware());
  middleware.push(new ToolExceptionRecoveryMiddleware());
  middleware.push(new ResumeStateMiddleware());

  // Local context middleware (project detection via bash script)
  // Added when the backend supports shell execution (LocalShellBackend)
  if (config.enableShell && backend && typeof (backend as any).execute === "function") {
    middleware.push(new LocalContextMiddleware(backend, mcpServerInfos));
  }

  // ---- 6. Assemble subagents (external + built-in) ----
  // External subagents (file-source + user-defined) are discovered/merged by
  // the server and injected via options.userSubagents — core stays DB-free.
  // Built-in subagents (Explore, general-purpose) come from BUILTIN_SUBAGENTS.
  // Filter out disabled external subagents; built-ins are always enabled.
  const externalSubagents = (options?.userSubagents ?? []).filter((s) => s.enabled !== false);

  /**
   * Resolve a tool-name whitelist into StructuredTool instances from the main
   * agent's compiled toolset. Enables the SDK's `SubAgent.tools` capability
   * (previously unused). Unknown tool names (e.g. an MCP tool that wasn't
   * loaded) are skipped with a warning rather than failing the build.
   */
  const resolveToolWhitelist = (names: string[] | undefined): any[] | undefined => {
    if (!names || names.length === 0) return undefined;
    const byName = new Map<string, any>();
    for (const t of tools) {
      if (t?.name) byName.set(t.name, t);
    }
    const resolved: any[] = [];
    for (const n of names) {
      const t = byName.get(n);
      if (t) {
        resolved.push(t);
      } else {
        logger.warn(
          `Subagent tool whitelist references unknown tool "${n}" — ` +
          `it is not in the main agent toolset and will be ignored. ` +
          `Available tools: ${[...byName.keys()].join(", ")}`,
        );
      }
    }
    return resolved.length > 0 ? resolved : undefined;
  };

  // Build the createDeepAgent `subagents` array. Two groups:
  //   - external subagents (file + user-defined): always injected explicitly.
  //   - built-in subagents with injectedBy === "explicit" (Explore): injected.
  // Built-ins with injectedBy === "sdk" (general-purpose) are auto-injected by
  // the SDK itself — including them here would create duplicates, so they are
  // skipped (but still mirrored into the registry below).
  //
  // Every subagent spec carries a `middleware` field with the
  // BinaryContentSanitizerMiddleware. The SDK merges it via
  // `...input.middleware ?? []` (see normalizeSubagentSpec), but the main
  // agent's middleware stack is NOT inherited by subagents — so without this,
  // a subagent's `read_file` on a binary file yields a `{type:"file"}` block
  // that crashes the Rust checkpointer on the next turn (400 deserialization
  // error). Explore (which exists to read files) is especially vulnerable.
  const subagentMiddleware = [new BinaryContentSanitizerMiddleware()];
  const subagentSpecs: any[] = [];
  for (const sa of externalSubagents) {
    const spec: Record<string, unknown> = {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      // Propagate the binary-content sanitizer — see comment above.
      middleware: subagentMiddleware,
    };
    const whitelist = resolveToolWhitelist(sa.tools);
    if (whitelist) spec.tools = whitelist;
    if (sa.model) spec.model = sa.model;
    subagentSpecs.push(spec);
  }
  for (const sa of BUILTIN_SUBAGENTS) {
    if (sa.injectedBy !== "explicit") continue;
    const spec: Record<string, unknown> = {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      // Propagate the binary-content sanitizer — see comment above.
      middleware: subagentMiddleware,
    };
    // Built-in explicit subagents force their own whitelist (Explore is
    // read-only by construction) — the value on the BuiltInSubagent wins.
    const whitelist = resolveToolWhitelist(sa.tools);
    if (whitelist) spec.tools = whitelist;
    if (sa.model) spec.model = sa.model;
    subagentSpecs.push(spec);
  }

  // ---- 7. Load skills ----
  const userSkillsDir = join(homedir(), ".deepagents", config.assistantId ?? "agent", "skills");
  const userAgentSkillsDir = join(homedir(), ".agents", "skills");
  const userClaudeSkillsDir = join(homedir(), ".claude", "skills");

  // Built-in skills shipped with the package
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const builtInSkillsDir = join(__dirname, "built_in_skills");

  const skillsList = listSkills({
    builtInSkillsDir: existsSync(builtInSkillsDir) ? builtInSkillsDir : null,
    userSkillsDir: existsSync(userSkillsDir) ? userSkillsDir : null,
    userAgentSkillsDir: existsSync(userAgentSkillsDir) ? userAgentSkillsDir : null,
    projectSkillsDir: projectContext.projectSkillsDir,
    projectAgentSkillsDir: projectContext.projectAgentSkillsDir,
    userClaudeSkillsDir: existsSync(userClaudeSkillsDir) ? userClaudeSkillsDir : null,
    projectClaudeSkillsDir: projectContext.projectRoot
      ? join(projectContext.projectRoot, ".claude", "skills")
      : null,
  });

  // Build skill source paths for createSkillsMiddleware / createDeepAgent skills option
  const skillSourcePaths: Array<[string, string]> = [];
  const seenDirs = new Set<string>();
  for (const skill of skillsList) {
    // Extract the skills root directory from the skill path
    // Skill path is like: {rootDir}/{name}/SKILL.md
    const parts = skill.path.replace(/\\/g, "/").split("/");
    if (parts.length >= 2) {
      const rootDir = parts.slice(0, -2).join("/");
      if (!seenDirs.has(rootDir)) {
        seenDirs.add(rootDir);
        // Determine label from source
        let label: string;
        switch (skill.source) {
          case "built-in": label = "Built-in"; break;
          case "user": label = rootDir.includes(".agents") ? "User Agents" : "User Deepagents"; break;
          case "project": label = rootDir.includes(".agents") ? "Project Agents" : "Project Deepagents"; break;
          case "claude (experimental)": label = rootDir.includes(homedir()) ? "User Claude" : "Project Claude"; break;
          default: label = "Unknown";
        }
        skillSourcePaths.push([rootDir, label]);
      }
    }
  }

  // ---- 8. Generate system prompt ----
  let systemPrompt = config.systemPrompt;
  if (!systemPrompt) {
    const modelIdentitySection = buildModelIdentitySection(
      modelName,
      provider,
      // Context limit and unsupported modalities from model profile (Phase 2)
    );
    systemPrompt = getSystemPrompt({
      assistantId: config.assistantId ?? "agent",
      cwd,
      interactive: config.interactive,
      modelIdentitySection,
    });
  }

  // ---- 9. Configure HITL interrupts ----
  let interruptOn: any = {};
  if (config.autoApprove) {
    // No HITL interrupts — tools run automatically (empty object = no interrupts)
  } else if (config.interactive) {
    // Full HITL for destructive operations
    interruptOn = _addInterruptOn();
  }
  // else: non-interactive mode — empty interrupts (headless execution)

  // ---- 11. Compile the agent graph via deepagents SDK ----
  // Note: web mode disables ask_user and memory middleware
  // (matching Python's web-mode configuration in make_graph()).
  // Enable_shell is already controlled by the backend choice above.
  // The deepagents SDK provides shell/filesystem/todo tools via middleware.
  const agent = createDeepAgent({
    model,
    systemPrompt,
    tools,
    checkpointer: getCheckpointer(),
    backend: compositeBackend,
    middleware,
    interruptOn,
    subagents: subagentSpecs.length > 0 ? subagentSpecs : undefined,
    skills: skillSourcePaths.length > 0 ? skillSourcePaths.map(([p]) => p) : undefined,
  });

  // ---- 11. Log summary ----
  const builtinCount = tools.length - mcpToolsCount;
  logger.info(
    `Graph created: model=${config.model} assistant_id=${config.assistantId ?? "agent"} ` +
    `tools=${tools.length} (builtin=${builtinCount} mcp=${mcpToolsCount}) ` +
    `subagents=${subagentSpecs.length} skills=${skillsList.length}`,
  );

  // ---- 12. Build subagent registry ----
  // The registry lets callers (e.g. the server) look up a subagent's system
  // prompt at runtime when it is invoked via the `task` tool. We mirror every
  // subagent — external (file/user-defined) AND built-in — so wrapAgentStream
  // can resolve the systemPrompt regardless of who injected the subagent.
  // Built-ins with injectedBy === "sdk" (general-purpose) are NOT in
  // subagentSpecs (the SDK auto-injects them), but we still mirror them here.
  const subagentRegistry = new Map<string, SubagentRegistryEntry>();
  for (const sa of externalSubagents) {
    subagentRegistry.set(sa.name, {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      source: (sa.source === "file" ? "user" : "user-defined") as
        | "user"
        | "project"
        | "user-defined",
    });
  }
  for (const sa of BUILTIN_SUBAGENTS) {
    // Don't clobber a user-provided subagent that intentionally shadows a
    // built-in name (e.g. a custom "general-purpose").
    if (subagentRegistry.has(sa.name)) continue;
    subagentRegistry.set(sa.name, {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      source: "builtin",
    });
  }

  return { agent, subagentRegistry };
}

// =============================================================================
// createAgent — backward-compatible alias.
// =============================================================================

/**
 * Build a compiled LangGraph agent graph from a ServerConfig.
 *
 * This is a backward-compatible alias for `makeGraph()`.
 * Prefer `makeGraph()` for new code — it supports full config wiring.
 *
 * @deprecated Use `makeGraph()` for full config.toml integration.
 */
export async function createAgent(config: ServerConfig): Promise<any> {
  return makeGraph(config);
}

export type AgentGraph = Awaited<ReturnType<typeof makeGraph>>;

// =============================================================================
// buildChatModel — public alias for the internal model constructor.
//
// Exposed so non-graph callers (e.g. title generation) can reuse the same
// config.toml / provider-override / env-var resolution logic without spinning
// up a full LangGraph deepagents graph.
// =============================================================================

/**
 * Build a standalone LangChain chat model from a `provider:model` spec.
 *
 * Reuses the same `_buildChatModel` that `makeGraph` uses internally, so the
 * provider config (base_url, api_key_env, params) resolution is identical.
 * Unlike `makeGraph`, this does NOT attach a checkpointer, tools, or the
 * deepagents middleware stack — it returns a bare `BaseChatModel` you can call
 * `.invoke()` / `.stream()` on directly.
 */
export async function buildChatModel(
  modelSpec: string,
  providerOverrides?: Record<string, { baseUrl?: string; apiKeyEnv?: string; apiKey?: string }>,
): Promise<any> {
  const { model } = await _buildChatModel(modelSpec, providerOverrides);
  return model;
}

// =============================================================================
// generateTitle — auto-summarize a conversation title from the first user turn.
//
// Equivalent to the Python project's frontend-driven title generation
// (ui/web/src/apis/agent_api.js generateTitle + AgentChatComponent.vue
// orchestration), moved server-side into core so the web client doesn't need
// a separate /call round-trip.
//
// - Uses a single non-streaming model.invoke([HumanMessage]) call.
// - Prompt asks for ≤30 chars, no markdown.
// - Output is truncated to 30 chars and whitespace-collapsed.
// - Returns null on any failure so callers can fall back to a truncated user msg.
// =============================================================================

/** Max title length (characters), matching the reference implementation. */
export const TITLE_MAX_LENGTH = 30;

/**
 * Generate a short conversation title from the user's first message.
 *
 * @param userMessage  The user's first turn text (truncated to 2000 chars internally).
 * @param modelSpec    A `provider:model` spec; resolved via the same config.toml
 *                     rules as the main agent model.
 * @returns The generated title (≤30 chars), or `null` if generation failed.
 */
export async function generateTitle(
  userMessage: string,
  modelSpec: string,
): Promise<string | null> {
  const titleLogger = getLogger("agent.title");
  // Match the reference: cap the prompt input at 2000 chars.
  const snippet = userMessage.replace(/\s+/g, " ").trim().slice(0, 2000);

  const prompt =
    `根据以下对话内容生成一个简短的标题（最多30个字符，中英文均可），` +
    `不要包含 markdown 标记：\n\n${snippet}`;

  try {
    const model = await buildChatModel(modelSpec);
    const { HumanMessage } = await import("@langchain/core/messages");
    const res = await model.invoke([new HumanMessage(prompt)]);
    const raw: string =
      typeof res?.content === "string"
        ? res.content
        : Array.isArray(res?.content)
          ? res.content
              .map((b: any) => (b?.type === "text" ? b.text : ""))
              .join("")
          : "";
    const title = raw.slice(0, TITLE_MAX_LENGTH).replace(/\s+/g, " ").trim();
    titleLogger.debug(`Generated title "${title}" from snippet (${snippet.length} chars)`);
    return title || null;
  } catch (err) {
    titleLogger.exception("Title generation failed", err);
    return null;
  }
}
