// Logging
export { configure, getLogger, withContext, getLogContext, LogLevel } from "./logging.js";
export type { Logger, LogContext } from "./logging.js";

// Agent graph
export { createAgent, makeGraph, getCheckpointer, clearGraphCache, buildChatModel, generateTitle, TITLE_MAX_LENGTH } from "./agent.js";
export type { AgentGraph, CompiledAgent, SubagentRegistryEntry } from "./agent.js";

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
export { FileEditGuardMiddleware, detectFileWrite } from "./middleware/file_edit_guard.js";
export { ToolExceptionRecoveryMiddleware } from "./middleware/tool_exception_recovery.js";
export { ResumeStateMiddleware } from "./middleware/resume_state.js";
export { ShellAllowListMiddleware, isShellCommandAllowed, ShellAllowAll } from "./middleware/shell_allow_list.js";
export { LocalContextMiddleware, buildDetectScript, buildMcpContext } from "./middleware/local_context.js";

// ServerConfig
export { loadConfig, fromDict, toDict, ServerConfigSchema } from "./config.js";
export type { ServerConfig } from "./config.js";

// ModelConfig (config.toml reader)
export { ModelConfig, resolveEnvVar, clearCaches } from "./model_config.js";
export type { ProviderConfig, ModelConfigData } from "./model_config.js";

// Config writers
export { saveDefaultModel, saveRecentModel, clearDefaultModel, listProvidersOverview, saveProviderConfig } from "./model_config.js";
export type { ProviderOverview, ProviderConfigPatch } from "./model_config.js";
export {
  getSandboxConfig,
  saveSandboxConfig,
  sandboxHasCredentials,
  resolveSandboxApiKey,
} from "./model_config.js";
export type { SandboxConfig, SandboxProvider } from "./model_config.js";

// Settings (env + API keys)
export { fromEnvironment, reloadFromEnvironment, loadDotEnv } from "./settings.js";
export type { Settings } from "./settings.js";

// Built-in tools
export { fetchUrl, webSearch, getBuiltinTools, getBuiltinToolsAsStructuredTools } from "./tools.js";
export type { FetchUrlResult, WebSearchResult, WebSearchResultItem } from "./tools.js";

// Subagents
export { listSubagents } from "./subagents.js";
export type { SubagentMetadata } from "./subagents.js";

// Skills
export { listSkills, loadSkillContent, validateSkillName, generateSkillTemplate } from "./skills.js";
export type { SkillMetadata, SkillSource, ListSkillsOptions } from "./skills.js";

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
} from "./config_types.js";
export type {
  SkillEntry,
  McpServerEntry,
  SkillOrigin,
  McpOrigin,
  SubagentEntry,
  SubagentOrigin,
} from "./config_types.js";

// MCP tools
export { loadMcpConfig, mergeMcpConfigs, discoverMcpConfigs, resolveAndLoadMcpTools } from "./mcp_tools.js";
export type { MCPToolInfo, MCPServerInfo, MCPServerStatus, McpLoadResult } from "./mcp_tools.js";

// MCP disabled servers
export { getDisabledServers, isServerDisabled, setServerDisabled } from "./mcp_disabled.js";

// MCP trust store
export { computeConfigFingerprint, isProjectMcpTrusted, trustProjectMcp, revokeProjectMcpTrust } from "./mcp_trust.js";

// Project utilities
export { findProjectRoot, ProjectContext, getServerProjectContext } from "./project_utils.js";

// Unicode security
export {
  detectDangerousUnicode,
  stripDangerousUnicode,
  sanitizeControlChars,
  summarizeIssues,
  checkUrlSafety,
  iterStringValues,
} from "./unicode_security.js";
export type { UnicodeIssue, UrlSafetyResult } from "./unicode_security.js";

// Constants
export {
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  PROVIDER_API_KEY_ENV,
  PROVIDER_BASE_URL_ENV,
  DEFAULT_AGENT_ID,
} from "./constants.js";
