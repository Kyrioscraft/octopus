/**
 * @octopus/core public API.
 *
 * The export surface is the symbols actually consumed by server / tui /
 * tentacle (audited). Internal machinery (middleware classes, permission
 * evaluation internals, builtin tool factories) is deliberately NOT exported —
 * reach for the domain module if you need it.
 *
 * Domain layout (dependencies point downward only):
 *   logging            logger + AsyncLocalStorage context      (leaf)
 *   config/            ServerConfig schema + env loading
 *   config/constants   paths, env prefixes, provider registry  (leaf)
 *   platform/          shell/platform quirks                   (leaf)
 *   safety/            permission rules + unicode/url security (leaf)
 *   store/             JsonStore atomic persistence            (leaf+)
 *   providers/         model provider config (config.json)
 *   skills/            skill discovery + builtin assets
 *   mcp/               MCP config discovery/loading/persistence
 *   registry/          unified config views (skills/mcp/subagents/commands)
 *   agent/             runtime kernel, graph pipeline, presets, HITL
 *   engine/            AgentEvent protocol + LangChain stream adapter
 */

// =============================================================================
// Logging
// =============================================================================
export { configure, getLogger, withContext, getLogContext, LogLevel } from "./logging.js";
export type { Logger, LogContext } from "./logging.js";

// =============================================================================
// Agent runtime (kernel + pipeline)
// =============================================================================
export { makeGraph, createAgent } from "./agent/index.js";
export { getCheckpointer, setCheckpointer, clearGraphCache } from "./agent/index.js";
export { buildChatModel, generateTitle, TITLE_MAX_LENGTH } from "./agent/index.js";
export { interruptOnForMode } from "./agent/index.js";
export type { AgentGraph, CompiledAgent, SubagentRegistryEntry, ExternalSubagentSpec } from "./agent/index.js";

// Agent presets (plan/confirm/auto/full) + legacy access-mode aliases
export { BUILTIN_AGENTS, AGENT_ORDER, DEFAULT_AGENT, GATED_TOOLS } from "./agent/presets.js";
export { resolveAgentPreset, presetForAccessMode, interruptOnForRuleset } from "./agent/presets.js";
export type { AgentPreset } from "./agent/presets.js";
export { DESTRUCTIVE_TOOLS } from "./agent/access-mode.js";
export type { AccessMode } from "./agent/access-mode.js";

// Subagents (builtin data + FS scanner)
export { BUILTIN_SUBAGENTS, EXPLORE_SUBAGENT, GENERAL_PURPOSE_BUILTIN, READONLY_TOOL_NAMES } from "./agent/subagent-defs.js";
export type { BuiltInSubagent, BuiltinSubagentInjector } from "./agent/subagent-defs.js";
export { listSubagents } from "./agent/subagents.js";
export type { SubagentMetadata } from "./agent/subagents.js";

// =============================================================================
// Engine — event protocol + stream adapter
// =============================================================================
export { wrapAgentStream } from "./engine/index.js";
export type { AgentEvent, AgentRunInput } from "./engine/index.js";

// =============================================================================
// ServerConfig
// =============================================================================
export { loadConfig, fromDict, toDict, ServerConfigSchema } from "./config/index.js";
export type { ServerConfig } from "./config/index.js";

// =============================================================================
// Providers — model config store (config.json)
// =============================================================================
export { ModelConfig, resolveEnvVar, clearCaches } from "./providers/index.js";
export type { ProviderConfig, ModelConfigData } from "./providers/index.js";
export { saveDefaultModel, saveRecentModel, clearDefaultModel, listProvidersOverview, saveProviderConfig } from "./providers/index.js";
export type { ProviderOverview, ProviderConfigPatch } from "./providers/index.js";
export { getSandboxConfig, saveSandboxConfig, sandboxHasCredentials, resolveSandboxApiKey } from "./providers/index.js";
export type { SandboxConfig, SandboxProvider } from "./providers/index.js";

// Settings (env + API keys)
export { fromEnvironment, reloadFromEnvironment, loadDotEnv } from "./config/settings.js";
export type { Settings } from "./config/settings.js";

// =============================================================================
// Skills
// =============================================================================
export { listSkills, loadSkillContent, validateSkillName, generateSkillTemplate } from "./skills/loader.js";
export type { SkillMetadata, SkillSource, ListSkillsOptions } from "./skills/loader.js";

// =============================================================================
// MCP
// =============================================================================
export { loadMcpConfig, mergeMcpConfigs, discoverMcpConfigs, resolveAndLoadMcpTools } from "./mcp/index.js";
export type { MCPToolInfo, MCPServerInfo, MCPServerStatus, McpLoadResult } from "./mcp/index.js";
export { getDisabledServers, isServerDisabled, setServerDisabled } from "./mcp/disabled.js";
export { computeConfigFingerprint, isProjectMcpTrusted, trustProjectMcp, revokeProjectMcpTrust } from "./mcp/trust.js";

// =============================================================================
// Registry — unified config views (skills / mcp / subagents / slash commands)
// =============================================================================
export {
  tagFileSkills, mergeSkillEntries, buildUserSkillContent,
  tagFileMcpServers, mergeMcpEntries, inferTransport,
  tagFileSubagents, mergeSubagentEntries,
} from "./registry/entries.js";
export type {
  SkillEntry, McpServerEntry, SkillOrigin, McpOrigin, SubagentEntry, SubagentOrigin,
} from "./registry/entries.js";
export { BUILTIN_SLASH_COMMANDS } from "./registry/builtin-commands.js";
export type { BuiltinSlashCommand, SlashCommandKind, SystemAction } from "./registry/builtin-commands.js";

// =============================================================================
// Project context
// =============================================================================
export { findProjectRoot, ProjectContext, getServerProjectContext } from "./config/project.js";

// =============================================================================
// Safety — unicode/URL input security (permission internals stay private)
// =============================================================================
export { detectDangerousUnicode, stripDangerousUnicode, sanitizeControlChars, summarizeIssues, checkUrlSafety } from "./safety/security.js";
export type { UnicodeIssue, UrlSafetyResult } from "./safety/security.js";

// =============================================================================
// Constants
// =============================================================================
export { DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_PATH, PROVIDER_API_KEY_ENV, PROVIDER_BASE_URL_ENV, DEFAULT_AGENT_ID } from "./config/constants.js";
