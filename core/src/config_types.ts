/**
 * Configuration management types + pure helper functions.
 *
 * These are the shared contract for skill/mcp configuration across web, tui,
 * and server. Pure functions only — no I/O, no DB, no HTTP. The server's
 * service layer orchestrates file-source (read-only) + user-defined (DB)
 * merging using these helpers; tui can use them directly to merge its local
 * file view with HTTP-fetched user-defined entries.
 *
 * See ARCHITECTURE_PLAN.md §11 for the full design.
 */

import type { SkillMetadata } from "./skills.js";
import type { SubagentMetadata } from "./subagents.js";
import type { MCPServerStatus } from "./mcp_tools.js";

// =============================================================================
// Types
// =============================================================================

/** Where a skill entry came from — determines editability. */
export type SkillOrigin = "builtin" | "file" | "user-defined";

/** Where an MCP server entry came from — determines editability. */
export type McpOrigin = "file" | "user-defined";

/**
 * A skill entry in the unified config view. `origin` drives whether the web/tui
 * UI offers edit/delete (user-defined only); file/builtin sources are read-only.
 */
export interface SkillEntry extends SkillMetadata {
  origin: SkillOrigin;
  editable: boolean;
  /** user-defined entries carry their DB id; file/builtin carry the file path. */
  description: string;
}

/**
 * An MCP server entry in the unified config view.
 */
export interface McpServerEntry {
  name: string;
  origin: McpOrigin;
  editable: boolean;
  transport: "stdio" | "sse" | "http" | "streamable-http";
  /** command/args/env (stdio) or url/headers (sse/http). */
  config: Record<string, unknown>;
  /** Disabled state (runtime, persisted in config.json via setServerDisabled). */
  enabled: boolean;
  /** Connection status — only populated when list is called with probe=true. */
  status?: MCPServerStatus;
  /** Error detail when status !== "ok". */
  error?: string;
}

// =============================================================================
// Pure helpers — skill
// =============================================================================

/**
 * Tag file-discovered SkillMetadata with origin + editable=false.
 *
 * @param skills raw skill metadata from listSkills()
 * @param builtinNames set of skill names that are built-in (shipped with core)
 */
export function tagFileSkills(
  skills: SkillMetadata[],
  builtinNames: Set<string>,
): SkillEntry[] {
  return skills.map((s) => ({
    ...s,
    origin: builtinNames.has(s.name) ? "builtin" : "file",
    editable: false,
  }));
}

/**
 * Merge file-source + user-defined skill entries. user-defined overrides
 * same-named file/builtin entries (highest precedence), matching the existing
 * skills discovery precedence model.
 */
export function mergeSkillEntries(
  file: SkillEntry[],
  userDefined: SkillEntry[],
): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  // file first (lower precedence)
  for (const s of file) byName.set(s.name, s);
  // user-defined last (higher precedence — overwrites)
  for (const s of userDefined) byName.set(s.name, s);
  return [...byName.values()];
}

/**
 * Build the SKILL.md content for a user-defined skill. Pure string generation —
 * does not touch the filesystem. The server writes the result to its DB.
 */
export function buildUserSkillContent(
  name: string,
  description: string,
  body: string,
): string {
  const desc = description.trim() || `${name} skill`;
  const content = body.trim();
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${content}\n`;
}

// =============================================================================
// Pure helpers — MCP
// =============================================================================

/**
 * Tag file-discovered MCP server configs (from .mcp.json) with origin + editable.
 *
 * @param servers raw { name -> config } map from mergeMcpConfigs()
 * @param disabled set of disabled server names (from getDisabledServers)
 */
export function tagFileMcpServers(
  servers: Record<string, Record<string, unknown>>,
  disabled: Set<string>,
): McpServerEntry[] {
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    origin: "file" as const,
    editable: false,
    transport: inferTransport(cfg),
    config: cfg,
    enabled: !disabled.has(name),
  }));
}

/**
 * Merge file-source + user-defined MCP server entries. user-defined overrides
 * same-named file entries.
 */
export function mergeMcpEntries(
  file: McpServerEntry[],
  userDefined: McpServerEntry[],
): McpServerEntry[] {
  const byName = new Map<string, McpServerEntry>();
  for (const s of file) byName.set(s.name, s);
  for (const s of userDefined) byName.set(s.name, s);
  return [...byName.values()];
}

/** Infer transport type from a server config object. */
export function inferTransport(
  cfg: Record<string, unknown>,
): "stdio" | "sse" | "http" | "streamable-http" {
  const t = cfg["transport"] as string | undefined;
  if (t === "sse" || t === "http" || t === "streamable-http") return t;
  // stdio when a command is present and no explicit transport
  return "stdio";
}

// =============================================================================
// Types — subagent (mirrors skill/mcp config-view pattern)
// =============================================================================

/** Where a subagent entry came from — determines editability. */
export type SubagentOrigin = "file" | "user-defined";

/**
 * A subagent entry in the unified config view. `origin` drives whether the
 * web/tui UI offers edit/delete (user-defined only); file/project sources are
 * read-only.
 */
export interface SubagentEntry {
  name: string;
  description: string;
  systemPrompt: string;
  /** Optional model override in 'provider:model-name' format. */
  model?: string | null;
  /** Tool name whitelist (strings). */
  tools: string[];
  origin: SubagentOrigin;
  editable: boolean;
  /** Runtime enabled state (user-defined only; file entries are always enabled). */
  enabled: boolean;
  /** Where this subagent was loaded from ('user' | 'project' | 'user-defined'). */
  source?: string;
  /** Absolute path (file/project) or DB id (user-defined). */
  path?: string;
}

// =============================================================================
// Pure helpers — subagent
// =============================================================================

/**
 * Tag file-discovered SubagentMetadata with origin + editable=false.
 * File/project subagents are always enabled in the unified view.
 */
export function tagFileSubagents(
  subagents: SubagentMetadata[],
): SubagentEntry[] {
  return subagents.map((s) => ({
    name: s.name,
    description: s.description,
    systemPrompt: s.systemPrompt,
    model: s.model ?? null,
    tools: [],
    origin: "file" as const,
    editable: false,
    enabled: true,
    source: s.source,
    path: s.path,
  }));
}

/**
 * Merge file-source + user-defined subagent entries. user-defined overrides
 * same-named file entries (highest precedence).
 */
export function mergeSubagentEntries(
  file: SubagentEntry[],
  userDefined: SubagentEntry[],
): SubagentEntry[] {
  const byName = new Map<string, SubagentEntry>();
  for (const s of file) byName.set(s.name, s);
  for (const s of userDefined) byName.set(s.name, s);
  return [...byName.values()];
}
