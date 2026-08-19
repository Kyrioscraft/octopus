// Logging
export { configure, getLogger, withContext, getLogContext, LogLevel } from "./logging.js";
export type { Logger, LogContext } from "./logging.js";

// Agent graph
export { createAgent, makeGraph, getCheckpointer, setCheckpointer, clearGraphCache, buildChatModel, generateTitle, TITLE_MAX_LENGTH } from "./agent/index.js";
export type { AgentGraph, CompiledAgent, SubagentRegistryEntry, ExternalSubagentSpec } from "./agent/index.js";

// Agent engine (standardized event model — decouples server from LangGraph)
export { wrapAgentStream } from "./engine.js";
export type { AgentEvent, AgentRunInput, AgentEngine } from "./engine.js";

// System prompt
export { getSystemPrompt, buildModelIdentitySection } from "./prompts.js";
export type { SystemPromptOptions } from "./prompts.js";

// Middleware
export { ConfigurableModelMiddleware } from "./middleware/configurable_model.js";
export { FilesystemEmptyResultMiddleware } from "./middleware/filesystem_empty_result.js";
export { BinaryContentSanitizerMiddleware } from "./middleware/binary_content_sanitizer.js";
export { FileEditGuardMiddleware, detectFileWrite, shouldInterruptExecute } from "./middleware/file_edit_guard.js";
export { ToolExceptionRecoveryMiddleware } from "./middleware/tool_exception_recovery.js";
export { ResumeStateMiddleware } from "./middleware/resume_state.js";
export { ShellAllowListMiddleware, isShellCommandAllowed, ShellAllowAll } from "./middleware/shell_allow_list.js";
export { LocalContextMiddleware, buildDetectScript, buildMcpContext } from "./middleware/local_context.js";
export { FilesystemPolicyMiddleware } from "./middleware/filesystem_policy_middleware.js";
export { ReadBudgetMiddleware } from "./middleware/read_budget_middleware.js";

// ServerConfig
export { loadConfig, fromDict, toDict, ServerConfigSchema, interruptOnForMode, DESTRUCTIVE_TOOLS } from "./config/index.js";
export type { ServerConfig, AccessMode } from "./config/index.js";

// ModelConfig (config.toml reader)
export { ModelConfig, resolveEnvVar, clearCaches } from "./providers/index.js";
export type { ProviderConfig, ModelConfigData } from "./providers/index.js";

// Config writers
export { saveDefaultModel, saveRecentModel, clearDefaultModel, listProvidersOverview, saveProviderConfig } from "./providers/index.js";
export type { ProviderOverview, ProviderConfigPatch } from "./providers/index.js";
export {
  getSandboxConfig,
  saveSandboxConfig,
  sandboxHasCredentials,
  resolveSandboxApiKey,
} from "./providers/index.js";
export type { SandboxConfig, SandboxProvider } from "./providers/index.js";

// Settings (env + API keys)
export { fromEnvironment, reloadFromEnvironment, loadDotEnv } from "./config/settings.js";
export type { Settings } from "./config/settings.js";

// Built-in tools
export { fetchUrl, webSearch, getBuiltinTools, getBuiltinToolsAsStructuredTools } from "./tools/web.js";
export type { FetchUrlResult, WebSearchResult, WebSearchResultItem } from "./tools/web.js";

// Subagents
export { listSubagents } from "./agent/subagents.js";
export type { SubagentMetadata } from "./agent/subagents.js";

// Built-in subagents (Explore, general-purpose, ...) — unified registry
export {
  EXPLORE_SUBAGENT,
  GENERAL_PURPOSE_BUILTIN,
  BUILTIN_SUBAGENTS,
  READONLY_TOOL_NAMES,
} from "./agent/subagent-defs.js";
export type { BuiltInSubagent, BuiltinSubagentInjector } from "./agent/subagent-defs.js";

// Builtin primary agents (agent-based successor to AccessMode — see
// agents/builtin.ts and architecture/AGENT_MIGRATION_PLAN.md)
export {
  BUILTIN_AGENTS,
  AGENT_ORDER,
  DEFAULT_AGENT,
  GATED_TOOLS,
  resolveAgentPreset,
  presetForAccessMode,
  interruptOnForRuleset,
} from "./agent/presets.js";
export type { AgentPreset } from "./agent/presets.js";

// Permission engine (pattern-based allow/ask/deny rules — phase 2)
export { evaluate, rulesetFromConfig, staticallyDisabledTools } from "./permission/index.js";
export { wildcardMatch } from "./permission/wildcard.js";
export {
  type Ruleset,
  type PermissionRule,
  type PermissionAction,
  type PermissionConfig,
  type PermissionDecision,
  PermissionDeniedError,
} from "./permission/types.js";

// Skills
export { listSkills, loadSkillContent, validateSkillName, generateSkillTemplate } from "./skills/loader.js";
export type { SkillMetadata, SkillSource, ListSkillsOptions } from "./skills/loader.js";

// Config management (skill/mcp/subagent unified view — pure helpers + types, see §11)
export {
  tagFileSkills,
  mergeSkillEntries,
  buildUserSkillContent,
  tagFileMcpServers,
  mergeMcpEntries,
  inferTransport,
  tagFileSubagents,
  mergeSubagentEntries,
} from "./config/entries.js";
export type {
  SkillEntry,
  McpServerEntry,
  SkillOrigin,
  McpOrigin,
  SubagentEntry,
  SubagentOrigin,
} from "./config/entries.js";

// MCP tools
export { loadMcpConfig, mergeMcpConfigs, discoverMcpConfigs, resolveAndLoadMcpTools } from "./mcp/index.js";
export type { MCPToolInfo, MCPServerInfo, MCPServerStatus, McpLoadResult } from "./mcp/index.js";

// MCP disabled servers
export { getDisabledServers, isServerDisabled, setServerDisabled } from "./mcp/disabled.js";

// MCP trust store
export { computeConfigFingerprint, isProjectMcpTrusted, trustProjectMcp, revokeProjectMcpTrust } from "./mcp/trust.js";

// Project utilities
export { findProjectRoot, ProjectContext, getServerProjectContext } from "./config/project.js";

// Unicode security
export {
  detectDangerousUnicode,
  stripDangerousUnicode,
  sanitizeControlChars,
  summarizeIssues,
  checkUrlSafety,
  iterStringValues,
} from "./security.js";
export type { UnicodeIssue, UrlSafetyResult } from "./security.js";

// Constants
export {
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  PROVIDER_API_KEY_ENV,
  PROVIDER_BASE_URL_ENV,
  DEFAULT_AGENT_ID,
} from "./config/constants.js";

// Built-in slash commands
export {
  BUILTIN_SLASH_COMMANDS,
  type BuiltinSlashCommand,
  type SlashCommandKind,
  type SystemAction,
} from "./builtin_commands.js";
