/**
 * Skills loader — discovers skills from filesystem directories.
 *
 * Skills are markdown files (SKILL.md) in skills/ directories. The deepagents
 * SDK provides `SkillsMiddleware` and `createSkillsMiddleware` for agent
 * integration; this module provides the filesystem discovery logic used to
 * feed skill paths to the middleware.
 *
 * 7-source discovery with precedence (lowest to highest):
 *   0. built-in (shipped with the package)
 *   1. user ~/.deepagents/{agent}/skills/
 *   2. user ~/.agents/skills/
 *   3. project .deepagents/skills/
 *   4. project .agents/skills/
 *   5. user ~/.claude/skills/ (experimental)
 *   6. project .claude/skills/ (experimental)
 *
 * Each source is individually try/except-guarded so an inaccessible directory
 * doesn't block discovery of others.
 *
 * Equivalent to Python `cortex.skills.load`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLogger } from "../logging.js";

const logger = getLogger("skills");

// =============================================================================
// Types — equivalent to Python `ExtendedSkillMetadata`.
// =============================================================================

export type SkillSource = "built-in" | "user" | "project" | "claude (experimental)";

export interface SkillMetadata {
  /** Skill name (unique identifier). */
  name: string;
  /** Human-readable description from YAML frontmatter. */
  description: string;
  /** Path to the SKILL.md file. */
  path: string;
  /** Where this skill was loaded from. */
  source: SkillSource;
  /** Optional metadata from the YAML frontmatter. */
  metadata?: Record<string, string>;
}

// =============================================================================
// Internal helpers.
// =============================================================================

/**
 * Minimal YAML frontmatter parser for flat key: value pairs.
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
 * Parse a single SKILL.md file and return its metadata.
 *
 * Reads YAML frontmatter for name/description, body is the skill content.
 *
 * @returns SkillMetadata or null if parsing fails.
 */
function _parseSkillFile(filePath: string): {
  name: string;
  description: string;
  metadata: Record<string, string>;
} | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^---\s*\n(.*?)\n---\s*\n?(.*)$/s);
    if (!match) return null;

    const frontmatter = _parseSimpleYaml(match[1]);
    if (!frontmatter) return null;

    const name = frontmatter["name"];
    if (typeof name !== "string" || !name) return null;

    const description = frontmatter["description"] || `${name} skill`;

    return {
      name,
      description: typeof description === "string" ? description : `${name} skill`,
      metadata: frontmatter,
    };
  } catch {
    return null;
  }
}

/**
 * Scan a directory recursively for SKILL.md files.
 *
 * Walks up to 2 levels deep (skill_dir/{name}/SKILL.md).
 *
 * @returns Map of skill name to parsed metadata.
 */
function _scanSkillsDir(skillDir: string, source: SkillSource): Map<string, SkillMetadata> {
  const skills = new Map<string, SkillMetadata>();

  try {
    if (!existsSync(skillDir)) return skills;
  } catch {
    return skills;
  }

  // Check for entries in this directory
  let entries: string[];
  try {
    entries = readdirSync(skillDir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const entryPath = join(skillDir, entry);
    try {
      // Direct SKILL.md in a subfolder
      if (statSync(entryPath).isDirectory()) {
        const skillMd = join(entryPath, "SKILL.md");
        if (existsSync(skillMd)) {
          const parsed = _parseSkillFile(skillMd);
          if (parsed) {
            skills.set(parsed.name, {
              name: parsed.name,
              description: parsed.description,
              path: skillMd,
              source,
              metadata: parsed.metadata,
            });
          }
        }
      }
    } catch {
      // Skip inaccessible entries
      continue;
    }
  }

  return skills;
}

// =============================================================================
// listSkills — equivalent to Python `list_skills()`.
// =============================================================================

export interface ListSkillsOptions {
  /** Path to built-in skills shipped with the package. */
  builtInSkillsDir?: string | null;
  /** Path to ~/.deepagents/{agent}/skills/ */
  userSkillsDir?: string | null;
  /** Path to ~/.agents/skills/ */
  userAgentSkillsDir?: string | null;
  /** Path to .deepagents/skills/ */
  projectSkillsDir?: string | null;
  /** Path to .agents/skills/ */
  projectAgentSkillsDir?: string | null;
  /** Path to ~/.claude/skills/ (experimental) */
  userClaudeSkillsDir?: string | null;
  /** Path to .claude/skills/ (experimental) */
  projectClaudeSkillsDir?: string | null;
}

/**
 * List skills from all configured directories.
 *
 * Precedence order (lowest to highest):
 *   built-in < user .deepagents < user .agents < project .deepagents
 *   < project .agents < user .claude < project .claude
 *
 * Skills from higher-precedence directories override those with the same name.
 *
 * Equivalent to Python `list_skills()`.
 */
export function listSkills(options: ListSkillsOptions = {}): SkillMetadata[] {
  const allSkills = new Map<string, SkillMetadata>();

  const sources: Array<{
    dir: string | null | undefined;
    source: SkillSource;
    experimental: boolean;
  }> = [
    { dir: options.builtInSkillsDir, source: "built-in", experimental: false },
    { dir: options.userSkillsDir, source: "user", experimental: false },
    { dir: options.userAgentSkillsDir, source: "user", experimental: false },
    { dir: options.projectSkillsDir, source: "project", experimental: false },
    { dir: options.projectAgentSkillsDir, source: "project", experimental: false },
    { dir: options.userClaudeSkillsDir, source: "claude (experimental)", experimental: true },
    { dir: options.projectClaudeSkillsDir, source: "claude (experimental)", experimental: true },
  ];

  for (const { dir, source, experimental } of sources) {
    if (!dir) continue;

    try {
      const dirSkills = _scanSkillsDir(dir, source);
      if (experimental && dirSkills.size > 0) {
        logger.info(
          `Discovered ${dirSkills.size} skill(s) from experimental Claude path: ${dir}`,
        );
      }
      for (const [name, skill] of dirSkills) {
        allSkills.set(name, skill);
      }
    } catch {
      // Degrade gracefully — one malformed source must not block discovery
      logger.warn(`Could not load skills from ${dir}`);
    }
  }

  return [...allSkills.values()];
}

/**
 * Load the raw content of a SKILL.md file.
 *
 * When `allowedRoots` is provided, the resolved path must fall within at
 * least one root directory (symlink containment check).
 *
 * @param skillPath    Path to the SKILL.md file.
 * @param allowedRoots Optional root directories for path containment.
 * @returns Full text content, or null on failure.
 *
 * Equivalent to Python `load_skill_content()`.
 */
export function loadSkillContent(
  skillPath: string,
  allowedRoots?: string[],
): string | null {
  const resolved = resolve(skillPath);

  if (allowedRoots && allowedRoots.length > 0) {
    const isContained = allowedRoots.some((root) =>
      resolved.startsWith(resolve(root)),
    );
    if (!isContained) {
      logger.warn(
        `Skill path ${skillPath} is outside all allowed roots, refusing to read`,
      );
      return null;
    }
  }

  try {
    return readFileSync(resolved, "utf-8");
  } catch {
    logger.warn(`Could not read skill content from ${skillPath}`);
    return null;
  }
}

// =============================================================================
// Skill commands helpers — equivalent to Python `skills.commands`.
// =============================================================================

/**
 * Validate a skill name (lowercase, hyphens, no spaces).
 *
 * @returns [isValid, errorMessage]
 */
export function validateSkillName(name: string): [boolean, string] {
  if (!name) return [false, "Skill name cannot be empty."];
  if (name.includes(" "))
    return [
      false,
      "Skill names must not contain spaces. Use hyphens instead (e.g. 'my-skill').",
    ];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return [
      false,
      "Skill name must contain only lowercase letters, digits, " +
      "and hyphens, and must start and end with a letter or digit.",
    ];
  }
  return [true, ""];
}

/**
 * Generate a default SKILL.md template for a new skill.
 *
 * Equivalent to Python `generate_skill_template()`.
 */
export function generateSkillTemplate(skillName: string): string {
  const title = skillName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return [
    "---",
    `name: ${skillName}`,
    `description: ${title} skill`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Purpose",
    "",
    "Describe what this skill does and when to use it.",
    "",
    "## Instructions",
    "",
    "Step-by-step instructions for the agent to follow.",
    "",
  ].join("\n");
}
