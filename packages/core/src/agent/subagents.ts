/**
 * Subagent loader — loads custom subagent definitions from the filesystem.
 *
 * Subagents are defined as markdown files with YAML frontmatter in the
 * agents/ directory.
 *
 * Directory structure:
 *     .deepagents/agents/{agent_name}/AGENTS.md
 *
 * Example file (researcher/AGENTS.md):
 *     ---
 *     name: researcher
 *     description: Research topics on the web before writing content
 *     model: anthropic:claude-haiku-4-5-20251001
 *     ---
 *
 *     You are a research assistant with access to web search.
 *
 * Equivalent to Python `cortex.subagents`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logging.js";

const logger = getLogger("subagents");

// =============================================================================
// Types — equivalent to Python `SubagentMetadata`.
// =============================================================================

export interface SubagentMetadata {
  /** Unique identifier for the subagent, used with the task tool. */
  name: string;
  /** What this subagent does (main agent uses this to decide when to delegate). */
  description: string;
  /** Instructions for the subagent (body of the markdown file). */
  systemPrompt: string;
  /** Optional model override in 'provider:model-name' format. */
  model?: string | null;
  /** Where this subagent was loaded from ('user' or 'project'). */
  source: string;
  /** Absolute path to the subagent definition file. */
  path: string;
}

// =============================================================================
// Internal helpers.
// =============================================================================

/**
 * Parse a subagent markdown file with YAML frontmatter.
 *
 * The file must have YAML frontmatter (delimited by ---) containing at minimum
 * 'name' and 'description' fields. The body becomes the systemPrompt.
 *
 * Equivalent to Python `_parse_subagent_file()`.
 */
function _parseSubagentFile(filePath: string): SubagentMetadata | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    // Extract YAML frontmatter (--- delimited)
    const match = content.match(/^---\s*\n(.*?)\n---\s*\n?(.*)$/s);
    if (!match) return null;

    const frontmatterStr = match[1];
    const body = match[2].trim();

    // Parse simple YAML (flat key: value pairs only)
    const frontmatter = _parseSimpleYaml(frontmatterStr);
    if (!frontmatter) return null;

    const name = frontmatter["name"];
    const description = frontmatter["description"];
    const model = frontmatter["model"];

    // Validate types: name and description must be non-empty strings
    if (typeof name !== "string" || !name) return null;
    if (typeof description !== "string" || !description) return null;
    if (model !== undefined && model !== null && typeof model !== "string") return null;

    return {
      name,
      description,
      systemPrompt: body,
      model: model ?? null,
      source: "", // Set by caller
      path: filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Minimal YAML frontmatter parser for flat key: value pairs.
 *
 * Handles quoted strings and unquoted values. Does NOT support nested
 * structures, arrays, or advanced YAML features — those are not needed
 * for subagent frontmatter.
 */
function _parseSimpleYaml(yaml: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  const lines = yaml.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Load subagents from a directory.
 *
 * Expects structure: agentsDir/{subagent_name}/AGENTS.md
 *
 * Equivalent to Python `_load_subagents_from_dir()`.
 */
function _loadSubagentsFromDir(
  agentsDir: string,
  source: "user" | "project",
): Map<string, SubagentMetadata> {
  const subagents = new Map<string, SubagentMetadata>();

  try {
    if (!existsSync(agentsDir)) return subagents;
    const st = statSync(agentsDir);
    if (!st.isDirectory()) return subagents;
  } catch {
    return subagents;
  }

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    logger.debug(`Could not read agents directory: ${agentsDir}`);
    return subagents;
  }

  for (const entry of entries) {
    const folderPath = join(agentsDir, entry);
    try {
      const st = statSync(folderPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    // Look for {folder_name}/AGENTS.md
    const agentsMd = join(folderPath, "AGENTS.md");
    if (!existsSync(agentsMd)) continue;

    const subagent = _parseSubagentFile(agentsMd);
    if (subagent) {
      subagent.source = source;
      subagents.set(subagent.name, subagent);
    }
  }

  return subagents;
}

// =============================================================================
// listSubagents — equivalent to Python `list_subagents()`.
// =============================================================================

/**
 * List subagents from user and/or project directories.
 *
 * Scans for subagent definitions in the provided directories.
 * Project subagents override user subagents with the same name.
 *
 * @param userAgentsDir    Path to user-level agents directory.
 * @param projectAgentsDir Path to project-level agents directory.
 * @returns List of subagent metadata, with project subagents taking precedence.
 *
 * Equivalent to Python `list_subagents()`.
 */
export function listSubagents(options: {
  userAgentsDir?: string | null;
  projectAgentsDir?: string | null;
}): SubagentMetadata[] {
  const allSubagents = new Map<string, SubagentMetadata>();

  // Load user subagents first (lower priority)
  if (options.userAgentsDir) {
    const userAgents = _loadSubagentsFromDir(options.userAgentsDir, "user");
    for (const [name, meta] of userAgents) {
      allSubagents.set(name, meta);
    }
  }

  // Load project subagents second (override user)
  if (options.projectAgentsDir) {
    const projectAgents = _loadSubagentsFromDir(options.projectAgentsDir, "project");
    for (const [name, meta] of projectAgents) {
      allSubagents.set(name, meta);
    }
  }

  return [...allSubagents.values()];
}
