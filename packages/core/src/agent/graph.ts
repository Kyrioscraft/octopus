/**
 * Agent graph factory — compile LangGraph graphs from ServerConfig.
 *
 * Equivalent to Python `cortex.server_graph.make_graph()` +
 * `cortex.agent.create_cli_agent()` (middleware stack, HITL, backend).
 *
 * Split co-conspirators (see agent/):
 *   - model.ts      — _buildChatModel / buildChatModel / generateTitle
 *   - backend.ts    — BashShellBackend / CompositeBackend construction
 *   - presets.ts    — AgentPreset resolution (plan/confirm/auto/full)
 *   - access-mode.ts — legacy AccessMode leaf (cycle break)
 *
 * This module owns: graph caching, HITL interrupt configuration, middleware
 * stack assembly, tool/subagent/skill wiring, and the checkpointer singleton.
 */

import { createDeepAgent } from "deepagents";
import { type ServerConfig } from "../config/index.js";
import { resolveAgentPreset } from "./presets.js";


import { getLogger } from "../logging.js";
import { getSystemPrompt } from "../prompts.js";
import { FilesystemEmptyResultMiddleware } from "../middleware/filesystem_empty_result.js";
import { BinaryContentSanitizerMiddleware } from "../middleware/binary_content_sanitizer.js";
import { FileEditGuardMiddleware } from "../middleware/file_edit_guard.js";
import { ToolExceptionRecoveryMiddleware } from "../middleware/tool_exception_recovery.js";
import { ResumeStateMiddleware } from "../middleware/resume_state.js";
import { LocalContextMiddleware } from "../middleware/local_context.js";
import { ConfigurableModelMiddleware } from "../middleware/configurable_model.js";
import { FilesystemPolicyMiddleware } from "../middleware/filesystem_policy_middleware.js";
import { ReadBudgetMiddleware } from "../middleware/read_budget_middleware.js";
import { SubagentOrchestrationMiddleware } from "../middleware/subagent_orchestration_middleware.js";
import { DynamicContextMiddleware } from "../middleware/dynamic_context_middleware.js";
import { getBuiltinToolsAsStructuredTools } from "../tools/index.js";
import { createAskUserQuestionTool } from "../tools/ask_user_question.js";
import { createSubmitPlanTool } from "../tools/submit_plan.js";
import { discoverSkillSources } from "../skills/loader.js";
import { resolveAndLoadMcpTools } from "../mcp/index.js";
import type { MCPServerInfo } from "../mcp/index.js";
import { ProjectContext } from "../config/project.js";
import { assembleSubagentSpecs, buildSubagentRegistry } from "./assembly.js";
import { _buildChatModel, buildChatModel } from "./model.js";
import { buildInterruptOn } from "./hitl.js";
import { buildBackend } from "./backend.js";
import { cacheKey, getCachedGraph, setCachedGraph, getCheckpointer } from "./kernel.js";

const logger = getLogger("agent.graph");

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
     * Primary agent name (e.g. "plan" | "confirm" | "auto" | "full" or a
     * user-defined primary agent). Resolved via resolveAgentPreset — drives
     * toolset shaping (plan strips destructive tools), FileEditGuard bypass
     * (full), submit_plan injection, and the mode guidance prompt block.
     * Part of the cache key so different agents compile separate graphs.
     */
    agent?: string;
    /**
     * External subagents (file-source + user-defined), already merged by the
     * server. core is a pure library with no DB access, so the server owns
     * discovery/merge and injects the result here. Built-in subagents
     * (Explore, general-purpose) are added by core itself — do not include
     * them in this list. Part of the cache key.
     */
    userSubagents?: ExternalSubagentSpec[];
    /**
     * Per-user model overrides for built-in subagents (name → 'provider:model',
     * null = inherit the default model). Built-ins cannot be edited/deleted,
     * but the UI allows overriding their model. Only applies to
     * injectedBy === "explicit" built-ins (Explore); SDK-injected ones
     * (general-purpose) cannot be overridden yet. Part of the cache key.
     */
    builtinSubagentOverrides?: Record<string, string | null>;
    /**
     * External tools injected by the server (e.g. the ripgrep extension's
     * `grep_search`). core is a pure library and does not discover extensions
     * itself — the server loads them and passes the constructed StructuredTool
     * instances here. Injected after built-in + MCP tools, before plan-mode
     * filtering. Part of the cache key.
     */
    externalTools?: any[];
    /**
     * Extra directories prepended to the shell backend's PATH (e.g. the
     * bundled ripgrep binary directory), so bare `rg` works in execute
     * commands without a host-wide ripgrep install. Not part of the cache
     * key — the dir is constant for a given install.
     */
    extraPathDirs?: string[];
  },
): Promise<CompiledAgent> {
  // ---- Cache key: every axis that changes the compiled graph shape ----
  const subagentSignature = (options?.userSubagents ?? [])
    .map((s) => `${s.name}:${(s.tools ?? []).slice().sort().join(",")}:${s.model ?? ""}:${s.enabled ?? true}`)
    .sort()
    .join("|");
  // Unknown agent names fall back to "confirm" inside resolveAgentPreset;
  // mirror that here so both resolve to the same cache entry.
  const agentName = options?.agent ?? "confirm";
  const key = cacheKey({
    model: config.model,
    systemPrompt: config.systemPrompt ?? "",
    tools: config.tools ?? [],
    enableShell: config.enableShell,
    enableWebSearch: config.enableWebSearch,
    mcpSignature: options?.mcpConfigPath ?? "",
    subagentSignature,
    workspace: options?.workspace?.environment === "sandbox" ? "sandbox" : "local",
    agent: agentName,
    externalTools: (options?.externalTools ?? []).map((t: any) => t?.name ?? "").sort().join(","),
    builtinSubagentOverrides: Object.entries(options?.builtinSubagentOverrides ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, m]) => `${n}=${m ?? ""}`)
      .join("|"),
    cwd: options?.cwd ?? "",
  });

  // Return cached graph if available
  const cached = getCachedGraph(key);
  if (cached) return cached;

  const promise = _makeGraphUncached(config, options);
  setCachedGraph(key, promise);
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
    /** Primary agent name — see makeGraph. */
    agent?: string;
    /** External subagents (file + user-defined), injected by the server. */
    userSubagents?: ExternalSubagentSpec[];
    /** Built-in subagent model overrides (name → model, null = default). */
    builtinSubagentOverrides?: Record<string, string | null>;
    /** External tools (e.g. ripgrep extension), injected by the server. */
    externalTools?: any[];
    /**
     * Extra directories to prepend to the shell backend's PATH (e.g. the
     * bundled ripgrep binary directory), so bare `rg` works in execute
     * commands without a host-wide ripgrep install.
     */
    extraPathDirs?: string[];
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

  // ---- 3a. Inject external tools (e.g. ripgrep extension) ----
  // External tools are injected AFTER built-in + MCP tools so they appear
  // alongside them, and BEFORE plan-mode filtering so any destructive
  // external tools are also stripped in plan mode. The server loads
  // extensions and constructs the StructuredTool instances; core just merges
  // them here. Tool selection priority is driven by descriptions (the model
  // picks based on guidance), not array index.
  //
  // NOTE: The SDK's ls/glob/grep tools are NOT removed here — they are
  // injected later by `createFilesystemMiddleware` (inside createDeepAgent)
  // at runtime. They are removed at runtime by `FilesystemPolicyMiddleware`
  // (see middleware/filesystem_policy_middleware.ts), which runs after the
  // SDK middleware in the chain. Search is unified through `grep_search`
  // (ripgrep, injected here) + `execute` (Bash, from the SDK).
  if (options?.externalTools && options.externalTools.length > 0) {
    tools.push(...options.externalTools);
    logger.info(`Injected ${options.externalTools.length} external tool(s): ${options.externalTools.map((t: any) => t?.name ?? "?").join(", ")}`);
  }

  // ---- 3b. agent preset — static toolset shaping (read-only enforcement in
  // plan, submit_plan injection) ----
  // Done AFTER MCP loading so MCP-registered destructive tools are also
  // removed. The preset is the data-driven successor of the old access-mode
  // switches (see agent/presets.ts); every legacy mode resolves to a preset
  // with identical behavior.
  const preset = resolveAgentPreset(options?.agent);
  if (preset.disabledTools.size > 0) {
    const before = tools.length;
    for (let i = tools.length - 1; i >= 0; i--) {
      if (preset.disabledTools.has(tools[i].name)) tools.splice(i, 1);
    }
    logger.info(
      `agent "${preset.name}": removed ${before - tools.length} disabled tool(s) ` +
      `(built-in + MCP); ${tools.length} tool(s) remain`,
    );
  }
  // Plan-mode approval gate (ZCode ExitPlanMode equivalent): the agent must
  // submit its plan for user approval before any execution happens. Also
  // injected in confirm mode — when the user approves a plan the server
  // resumes the thread on the confirm-compiled graph, and the ToolNode must
  // still contain submit_plan to resolve the pending interrupt.
  // Auto/full skip it (fully autonomous — no approval gate needed).
  if (preset.submitPlan) {
    tools.push(createSubmitPlanTool());
  }

  // ---- 4. Build CompositeBackend (sandbox or local) with temp-dir routing ----
  const backend = await buildBackend(config, {
    cwd,
    workspace: options?.workspace,
    extraPathDirs: options?.extraPathDirs,
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
  //
  // In `full` access mode the guard is bypassed: the user has opted into a
  // fully autonomous agent and accepts that shell commands may write files
  // directly. The agent name is part of the graph cache key, so `full` compiles
  // its own graph with the bypass enabled — cache-safe by construction.
  middleware.push(
    new FileEditGuardMiddleware({
      bypassWhenFull: preset.bypassFileEditGuard,
      fileWriteRuleset: preset.permission,
    }),
  );
  middleware.push(new ToolExceptionRecoveryMiddleware());
  middleware.push(new ResumeStateMiddleware());

  // Filesystem policy middleware — runs after the SDK's FilesystemMiddleware
  // (which appends its own tool descriptions and FILESYSTEM_SYSTEM_PROMPT).
  // Rewrites the FS tool descriptions and strips the SDK prompt so that
  // Octopus's "prefer grep/glob" guidance is the last word the model sees.
  middleware.push(new FilesystemPolicyMiddleware());

  // Read-budget middleware — runtime hints to curb over-exploration.
  // Scans request.messages before each model call; if the agent has read
  // too many files without acting (or is re-reading a file), appends a
  // [hint] to the system message. Soft (non-blocking), stateless, idempotent.
  middleware.push(new ReadBudgetMiddleware());

  // Subagent-orchestration middleware — makes the agent act as an orchestrator.
  // Appends an "orchestrator mindset" declaration (every call) and a dynamic
  // delegation hint (when over-searching without delegating is detected) to
  // the system message. Placed AFTER ReadBudgetMiddleware so it has the final
  // word — recency bias makes the last-appended text the strongest signal.
  // See middleware/subagent_orchestration_middleware.ts for rationale.
  middleware.push(new SubagentOrchestrationMiddleware());

  // DynamicContextMiddleware is pushed later (after `skillSourcePaths` is
  // populated) because it needs the resolved skills paths at construct
  // time. It is still pushed AFTER SubagentOrchestrationMiddleware, preserving
  // the intended stack order. See the push site for details.

  // Local context middleware (project detection via bash script)
  // Added when the backend supports shell execution (LocalShellBackend)
  if (config.enableShell && backend && typeof (backend as any).execute === "function") {
    middleware.push(new LocalContextMiddleware(backend, mcpServerInfos));
  }

  // ---- 6. Assemble subagents (specs + registry live in assembly.ts) ----
  const externalSubagents = (options?.userSubagents ?? []).filter((s) => s.enabled !== false);
  const subagentSpecs = assembleSubagentSpecs(
    externalSubagents,
    tools,
    options?.builtinSubagentOverrides,
  );

  // ---- 7. Discover skills (path conventions live in the skills domain) ----
  const { skills: skillsList, sourcePaths: skillSourcePaths } = discoverSkillSources({
    cwd,
    assistantId: config.assistantId,
    projectSkillsDir: projectContext.projectSkillsDir,
    projectAgentSkillsDir: projectContext.projectAgentSkillsDir,
    projectRoot: projectContext.projectRoot,
  });

  // ---- 8. Generate system prompt ----
  // The system prompt is now static (behavior conventions only). Dynamic
  // environment context (cwd, model identity, date, access mode) is injected
  // per-turn as <system-reminder> blocks by DynamicContextMiddleware.
  let systemPrompt = config.systemPrompt;
  if (!systemPrompt) {
    systemPrompt = getSystemPrompt({
      assistantId: config.assistantId ?? "agent",
      interactive: config.interactive,
    });
  }

  // Dynamic-context middleware — injects <system-reminder> blocks (current
  // date, working directory, model identity, access mode, skills path, output-
  // format constraints) into the latest user message. Mirrors ZCode's pattern:
  // the system message stays static (maximizing prompt-cache hits), while all
  // per-turn dynamic context rides on the user message. Pushed AFTER
  // SubagentOrchestrationMiddleware (which only edits systemMessage) so the
  // reminder is the last thing injected into the user message this turn.
  // Declared here (not in the main middleware stack block above) because it
  // needs `skillSourcePaths`, which is populated in the skills-discovery loop.
  middleware.push(
    new DynamicContextMiddleware({
      cwd,
      modelName,
      provider,
      interactive: config.interactive,
      agentName: preset.name,
      promptBlock: preset.promptBlock,
      skillsPath:
        skillSourcePaths.length > 0
          ? skillSourcePaths.map(([p]) => p).join(", ")
          : undefined,
      skills: skillsList.map((s) => ({ name: s.name, description: s.description })),
    }),
  );

  // ---- 9. Configure HITL interrupts ----
  let interruptOn: any = {};
  if (config.autoApprove) {
    // No HITL interrupts — tools run automatically (empty object = no interrupts)
  } else if (config.interactive) {
    // Full HITL for destructive operations. The preset's permission rules
    // drive the execute `when` predicate (shell file-write commands only
    // interrupt when their rule verdict is "ask").
    interruptOn = buildInterruptOn(preset.permission);
  }
  // else: non-interactive mode — empty interrupts (headless execution)

  // ---- 10. Compile the agent graph via deepagents SDK ----
  // Note: web mode disables ask_user and memory middleware
  // (matching Python's web-mode configuration in make_graph()).
  // Enable_shell is already controlled by the backend choice above.
  // The deepagents SDK provides shell/filesystem/todo tools via middleware.
  const agent = createDeepAgent({
    model,
    systemPrompt,
    tools,
    checkpointer: getCheckpointer() as any,
    backend,
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

  // ---- 12. Build subagent registry (assembly.ts) ----
  const subagentRegistry = buildSubagentRegistry(externalSubagents);

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
