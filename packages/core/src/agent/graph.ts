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
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { type ServerConfig } from "../config/index.js";
import type { AccessMode } from "./access-mode.js";
import { resolveAgentPreset } from "./presets.js";
import type { Ruleset } from "../permission/types.js";
import { evaluate } from "../permission/index.js";
import { getLogger } from "../logging.js";
import { getSystemPrompt } from "../prompts.js";
import { FilesystemEmptyResultMiddleware } from "../middleware/filesystem_empty_result.js";
import { BinaryContentSanitizerMiddleware } from "../middleware/binary_content_sanitizer.js";
import { FileEditGuardMiddleware, shouldInterruptExecute, detectFileWrite } from "../middleware/file_edit_guard.js";
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
import { listSkills } from "../skills/loader.js";
import { resolveAndLoadMcpTools } from "../mcp/index.js";
import type { MCPServerInfo } from "../mcp/index.js";
import { ProjectContext } from "../config/project.js";
import { BUILTIN_SUBAGENTS } from "./subagent-defs.js";
import { _buildChatModel, buildChatModel } from "./model.js";
import { buildBackend } from "./backend.js";
import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const logger = getLogger("agent.graph");

// =============================================================================
// Checkpointer — process-level singleton. Defaults to MemorySaver (state lost
// on restart); the server can inject a durable one (SQLite) via
// setCheckpointer() at startup so HITL interrupts survive restarts.
// =============================================================================

let _checkpointer: MemorySaver | unknown = null;

export function getCheckpointer(): unknown {
  if (!_checkpointer) {
    _checkpointer = new MemorySaver();
  }
  return _checkpointer;
}

/**
 * Replace the process-level checkpointer (e.g. with the SQLite checkpointer).
 * Must be called BEFORE any graph is built/used — existing compiled graphs
 * hold a reference to the previous instance, so this also clears the graph
 * cache to force recompilation against the new checkpointer.
 */
export function setCheckpointer(cp: unknown): void {
  _checkpointer = cp;
  clearGraphCache();
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
 *
 * @param fileWriteRuleset the preset's permission rules, used by the
 *        `execute` entry's `when` predicate: ordinary commands follow the
 *        `execute` rule verdict; detected file-write commands additionally
 *        follow `shell_file_write` (see shouldInterruptExecute — pairs with
 *        FileEditGuardMiddleware, which hard-blocks "deny").
 */
function _addInterruptOn(fileWriteRuleset?: Ruleset): Record<string, any> {
  const interruptMap: Record<string, any> = {
    execute: {
      allowedDecisions: ["approve", "reject"],
      // Dynamic description (langchain HITL calls description(toolCall, state,
      // runtime)) — surfaces WHY this command asks: the matched permission
      // rule for execute / shell_file_write, so the approval UI can show
      // "triggered by rule X" instead of a generic message.
      ...(fileWriteRuleset
        ? {
            description: (toolCall: { args?: Record<string, unknown> }) => {
              const command = String(toolCall?.args?.["command"] ?? "");
              const isFileWrite = !!detectFileWrite(command);
              const permission = isFileWrite ? "shell_file_write" : "execute";
              const decision = evaluate(permission, command, fileWriteRuleset);
              if (decision.rule) {
                return (
                  `Allow shell command execution? (matched permission rule ` +
                  `"${decision.rule.permission}: ${decision.rule.pattern}" → ${decision.rule.action})`
                );
              }
              return "Allow shell command execution? (no matching rule — default ask)";
            },
            when: (request: {
              toolCall: { name: string; args?: Record<string, unknown> };
            }) =>
              shouldInterruptExecute(
                String((request.toolCall.args as Record<string, unknown>)?.["command"] ?? ""),
                fileWriteRuleset,
              ),
          }
        : { description: "Allow shell command execution?" }),
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
     * Primary agent name (e.g. "plan" | "confirm" | "auto" | "full" or a
     * user-defined primary agent). Resolved via resolveAgentPreset — drives
     * toolset shaping (plan strips destructive tools), FileEditGuard bypass
     * (full), submit_plan injection, and the mode guidance prompt block.
     * Part of the cache key so different agents compile separate graphs.
     */
    agent?: string;
    /**
     * Legacy access mode — kept for backwards compatibility. Every legacy
     * mode resolves to the same-named builtin agent preset; `agent` wins
     * when both are given.
     *
     * @deprecated use `agent` instead
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
  const mcpSignature = options?.mcpConfigPath ?? "";
  // Include workspace environment in the cache key so local vs sandbox graphs
  // are not reused for each other.
  const wsSignature = options?.workspace?.environment === "sandbox" ? ":sandbox" : "";
  // The agent preset changes the toolset (plan removes destructive tools,
  // full bypasses FileEditGuard), so it must distinguish cache entries —
  // otherwise a confirm-compiled graph would be wrongly reused for a plan
  // request. Unknown names fall back to "confirm" inside resolveAgentPreset;
  // mirror that in the key so both resolve to the same cache entry.
  const modeSignature = options?.agent ?? options?.accessMode ?? "confirm";
  // Subagent shape (names + tool whitelists + model + enabled) affects the
  // compiled graph, so it must be part of the cache key — otherwise graphs
  // compiled for different user subagent configs would be wrongly reused.
  const subagentSignature = (options?.userSubagents ?? [])
    .map((s) => `${s.name}:${(s.tools ?? []).slice().sort().join(",")}:${s.model ?? ""}:${s.enabled ?? true}`)
    .sort()
    .join("|");
  // Built-in subagent model overrides affect the compiled graph (model choice
  // on the explicit built-in spec), so they must be part of the cache key.
  const builtinOverridesSignature = Object.entries(options?.builtinSubagentOverrides ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, m]) => `${n}=${m ?? ""}`)
    .join("|");
  // External tool names affect the compiled graph (the model sees them as
  // available tools), so they must be part of the cache key too.
  const externalToolsSignature = (options?.externalTools ?? [])
    .map((t: any) => t?.name ?? "")
    .sort()
    .join(",");
  const key = _cacheKey(config, mcpSignature, subagentSignature) + wsSignature + ":" + modeSignature + ":ext=" + externalToolsSignature + ":bso=" + builtinOverridesSignature + ":cwd=" + (options?.cwd ?? "");

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
    /** Primary agent name — see makeGraph. @deprecated-pair of accessMode */
    agent?: string;
    /** Legacy access mode — every legacy mode is a same-named builtin agent. */
    accessMode?: AccessMode;
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
  const preset = resolveAgentPreset(options?.agent ?? options?.accessMode);
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
  // directly. accessMode is part of the graph cache key, so `full` compiles
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
    // Per-user model override (from the server's builtin override store)
    // wins over the BuiltInSubagent's default. Note: SDK-injected built-ins
    // (general-purpose) skip this loop entirely, so their overrides are
    // recorded but not applied yet.
    const override = options?.builtinSubagentOverrides?.[sa.name];
    const model = override !== undefined ? override : sa.model;
    if (model) spec.model = model;
    subagentSpecs.push(spec);
  }

  // ---- 7. Load skills ----
  const userSkillsDir = join(homedir(), ".deepagents", config.assistantId ?? "agent", "skills");
  const userAgentSkillsDir = join(homedir(), ".agents", "skills");
  const userClaudeSkillsDir = join(homedir(), ".claude", "skills");

  // Built-in skills shipped with the package (src/skills/builtin/ — one level
  // up from this module's compiled output directory).
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const builtInSkillsDir = join(__dirname, "..", "skills", "builtin");

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
    interruptOn = _addInterruptOn(preset.permission);
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
