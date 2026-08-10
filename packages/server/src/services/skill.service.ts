/**
 * Skill config service — orchestrates file-source + user-defined skill views.
 *
 * Reads file-source skills (read-only, via core's listSkills) and user-defined
 * skills (DB), merges them with core's pure helpers, and applies the domain
 * rule: file/builtin are read-only, user-defined are editable. The route layer
 * calls these and encodes the result as JSON.
 *
 * See ARCHITECTURE_PLAN.md §11.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import AdmZip from "adm-zip";
import {
  listSkills,
  tagFileSkills,
  mergeSkillEntries,
  validateSkillName,
  buildUserSkillContent,
  loadSkillContent,
  findProjectRoot,
} from "@octopus/core";
import type { SkillEntry } from "@octopus/core";
import {
  listUserSkills,
  getUserSkill,
  upsertUserSkill,
  deleteUserSkill,
} from "../db/index.js";

// ESM-safe way to locate the @octopus/core package root (for built_in_skills).
const nodeRequire = createRequire(import.meta.url);

/**
 * Discover file-source skills, replicating the directory set that agent.ts
 * uses (built-in + user .deepagents/.agents/.claude + project equivalents).
 *
 * NOTE: this mirrors agent.ts:490-509 path construction. Kept inline (rather
 * than extracted to core) to satisfy the "minimize existing-code changes"
 * constraint — extracting a shared helper would mean editing agent.ts.
 */
function discoverFileSkills() {
  const userSkillsDir = join(homedir(), ".deepagents", "agent", "skills");
  const userAgentSkillsDir = join(homedir(), ".agents", "skills");
  const userClaudeSkillsDir = join(homedir(), ".claude", "skills");

  // Built-in skills shipped with core — resolve via the package's dist dir.
  let builtInSkillsDir: string | null = null;
  try {
    const coreDistPath = nodeRequire.resolve("@octopus/core");
    const coreDir = dirname(coreDistPath);
    const candidate = join(coreDir, "built_in_skills");
    builtInSkillsDir = existsSync(candidate) ? candidate : null;
  } catch {
    // Fallback: built-ins are optional, discovery degrades gracefully.
  }

  const projectRoot = findProjectRoot();
  return listSkills({
    builtInSkillsDir,
    userSkillsDir: existsSync(userSkillsDir) ? userSkillsDir : null,
    userAgentSkillsDir: existsSync(userAgentSkillsDir) ? userAgentSkillsDir : null,
    projectSkillsDir: projectRoot ? join(projectRoot, ".deepagents", "skills") : null,
    projectAgentSkillsDir: projectRoot ? join(projectRoot, ".agents", "skills") : null,
    userClaudeSkillsDir: existsSync(userClaudeSkillsDir) ? userClaudeSkillsDir : null,
    projectClaudeSkillsDir: projectRoot ? join(projectRoot, ".claude", "skills") : null,
  });
}

/** Resolve the built-in skills dir (shipped with core), or null if absent. */
function resolveBuiltinSkillsDir(): string | null {
  try {
    const coreDistPath = nodeRequire.resolve("@octopus/core");
    const coreDir = dirname(coreDistPath);
    const candidate = join(coreDir, "built_in_skills");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Names of built-in skills (shipped with core) — drives the origin tag. */
function getBuiltinSkillNames(): Set<string> {
  const dir = resolveBuiltinSkillsDir();
  if (!dir) return new Set();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return new Set(
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

/** Convert a DB user-skill row into a SkillEntry (origin=user-defined). */
function dbRowToEntry(row: {
  id: string;
  name: string;
  description: string;
  content: string;
}): SkillEntry {
  return {
    name: row.name,
    description: row.description,
    path: row.id, // user-defined has no filesystem path; use DB id
    source: "user",
    origin: "user-defined",
    editable: true,
  };
}

/**
 * List all skills (file + user-defined), merged. user-defined overrides
 * same-named file/builtin entries.
 */
export function listAllSkills(userId: string): SkillEntry[] {
  const fileSkills = tagFileSkills(discoverFileSkills(), getBuiltinSkillNames());
  const userSkills = listUserSkills(userId).map(dbRowToEntry);
  return mergeSkillEntries(fileSkills, userSkills);
}

/** Get a single skill's full content. */
export function getSkillDetail(
  userId: string,
  name: string,
): { content: string; origin: SkillEntry["origin"] } | null {
  // user-defined first (highest precedence)
  const userSkill = getUserSkill(userId, name);
  if (userSkill) {
    return { content: userSkill.content, origin: "user-defined" };
  }
  // file/builtin: read via core's discovery (content is the SKILL.md body)
  const fileSkills = discoverFileSkills();
  const found = fileSkills.find((s) => s.name === name);
  if (found) {
    // loadSkillContent reads the SKILL.md file; safe since path came from discovery.
    const content = loadSkillContent(found.path) ?? "";
    return { content, origin: "file" };
  }
  return null;
}

/** Create a user-defined skill. @throws on invalid name or conflict. */
export function createSkill(
  userId: string,
  input: { name: string; description: string; content: string },
): SkillEntry {
  const [valid, err] = validateSkillName(input.name);
  if (!valid) throw new Error(`无效的 skill 名称: ${err}`);
  // Allow override of file/builtin, but surface a clear error for same-name
  // user-defined (the DB unique constraint would catch it, but a better
  // message helps).
  if (getUserSkill(userId, input.name)) {
    throw new Error(`用户 skill "${input.name}" 已存在`);
  }
  const content = buildUserSkillContent(input.name, input.description, input.content);
  const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  upsertUserSkill({
    id,
    userId,
    name: input.name,
    description: input.description,
    content,
    createdAt: now,
    updatedAt: now,
  });
  return dbRowToEntry({ id, name: input.name, description: input.description, content });
}

/** Update a user-defined skill (file/builtin → throws not_editable). */
export function updateSkill(
  userId: string,
  name: string,
  patch: { description?: string; content?: string },
): SkillEntry {
  const existing = getUserSkill(userId, name);
  if (!existing) {
    // Could be a file-sourced skill the user tried to edit.
    const fileSkills = discoverFileSkills();
    if (fileSkills.some((s) => s.name === name)) {
      throw new NotEditableError(name, "file");
    }
    throw new Error(`skill "${name}" 不存在`);
  }
  const newDescription = patch.description ?? existing.description;
  const newContent = patch.content
    ? buildUserSkillContent(name, newDescription, patch.content)
    : existing.content;
  upsertUserSkill({
    ...existing,
    description: newDescription,
    content: newContent,
  });
  return dbRowToEntry({
    id: existing.id,
    name,
    description: newDescription,
    content: newContent,
  });
}

/** Delete a user-defined skill (file/builtin → throws not_editable). */
export function deleteSkill(userId: string, name: string): void {
  const existing = getUserSkill(userId, name);
  if (!existing) {
    const fileSkills = discoverFileSkills();
    if (fileSkills.some((s) => s.name === name)) {
      throw new NotEditableError(name, "file");
    }
    // Idempotent: deleting a non-existent skill is a no-op.
    return;
  }
  deleteUserSkill(userId, name);
}

/** Thrown when a write targets a read-only (file/builtin) source. */
export class NotEditableError extends Error {
  readonly origin: string;
  readonly name_: string;
  constructor(name: string, origin: string) {
    super(`skill "${name}" 来自 ${origin}，不可通过界面修改，请直接编辑文件`);
    this.name = "NotEditableError";
    this.name_ = name;
    this.origin = origin;
  }
}

// =============================================================================
// Skill import (.zip / .md upload)
// =============================================================================

/**
 * Minimal frontmatter parser for SKILL.md. Extracts `name` + `description`
 * from a leading `---\n...\n---` YAML block (flat key:value only). Returns
 * `{ name?, description?, body }` where body is the markdown after the block.
 */
function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = raw.match(/^---\s*\n(.*?)\n---\s*\n?(.*)$/s);
  if (!match) return { body: raw };
  const yaml = match[1];
  const body = match[2];
  const fields: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (m) fields[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { name: fields["name"], description: fields["description"], body };
}

/**
 * Import a skill from an uploaded .zip or .md file.
 *
 * - .zip: extracts entries, finds exactly one SKILL.md (rejecting path
 *   traversal), parses frontmatter.
 * - .md (or SKILL.md): treats the file content directly as SKILL.md.
 *
 * Reuses createSkill for the final DB write. @throws on invalid archive,
 * missing/duplicate SKILL.md, or invalid frontmatter.
 */
export function importSkill(
  userId: string,
  filename: string,
  fileBuffer: Buffer,
): SkillEntry {
  const lower = filename.toLowerCase();
  let skillMdContent: string;

  if (lower.endsWith(".zip")) {
    skillMdContent = extractSkillMdFromZip(fileBuffer);
  } else if (lower.endsWith("skill.md") || lower.endsWith(".md")) {
    skillMdContent = fileBuffer.toString("utf-8");
  } else {
    throw new Error("仅支持上传 .zip 文件或 SKILL.md 文件");
  }

  const parsed = parseSkillFrontmatter(skillMdContent);
  const name = parsed.name?.trim();
  const description = parsed.description?.trim() || "";
  const body = parsed.body.trim();
  if (!name) {
    throw new Error("SKILL.md 缺少 frontmatter 中的 name 字段");
  }
  return createSkill(userId, { name, description, content: body });
}

/**
 * Extract the single SKILL.md from a zip buffer. Rejects path traversal
 * (absolute paths, `..` segments) and requires exactly one SKILL.md entry.
 */
function extractSkillMdFromZip(buf: Buffer): string {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const skillMdEntries = entries.filter(
    (e) => !e.isDirectory && e.entryName.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === "skill.md",
  );
  if (skillMdEntries.length === 0) {
    throw new Error("ZIP 中未找到 SKILL.md 文件");
  }
  if (skillMdEntries.length > 1) {
    throw new Error("ZIP 只能包含一个 SKILL.md 文件");
  }
  // Path-traversal guard
  const entryName = skillMdEntries[0].entryName.replace(/\\/g, "/");
  if (entryName.startsWith("/") || entryName.includes("..")) {
    throw new Error("ZIP 包含非法路径");
  }
  return skillMdEntries[0].getData().toString("utf-8");
}

// =============================================================================
// Builtin skill catalog (install)
// =============================================================================

/** A builtin skill spec surfaced for installation in the UI. */
export interface BuiltinSkillSpec {
  slug: string;
  name: string;
  description: string;
  /** "installed" if a user-defined override exists; "not_installed" otherwise. */
  status: "installed" | "not_installed";
  /** The installed user-defined entry, when status === "installed". */
  installed_record: SkillEntry | null;
}

/**
 * List builtin skills (shipped with core) with install status. A builtin is
 * "installed" when a user-defined row with the same name exists (i.e. the user
 * has an editable copy via installBuiltinSkill or manual create).
 */
export function listBuiltinSkills(userId: string): BuiltinSkillSpec[] {
  const builtinNames = getBuiltinSkillNames();
  if (builtinNames.size === 0) return [];
  // Discover builtin skills' metadata via the same discovery used by listAll.
  const fileSkills = discoverFileSkills().filter((s) => builtinNames.has(s.name));
  return fileSkills.map((s) => {
    const installed = getUserSkill(userId, s.name);
    const spec: BuiltinSkillSpec = {
      slug: s.name,
      name: s.name,
      description: s.description,
      status: installed ? "installed" : "not_installed",
      installed_record: null,
    };
    if (installed) {
      spec.installed_record = dbRowToEntry(installed);
    }
    return spec;
  });
}

/**
 * Install a builtin skill: read its SKILL.md content, create a user-defined
 * (editable) copy. Subsequent edits go to the user-defined row; the builtin
 * source stays read-only on disk.
 * @throws if the slug is not a known builtin, or already installed.
 */
export function installBuiltinSkill(userId: string, slug: string): SkillEntry {
  const builtinNames = getBuiltinSkillNames();
  if (!builtinNames.has(slug)) {
    throw new Error(`内置 skill "${slug}" 不存在`);
  }
  if (getUserSkill(userId, slug)) {
    throw new Error(`内置 skill "${slug}" 已安装`);
  }
  const fileSkills = discoverFileSkills();
  const found = fileSkills.find((s) => s.name === slug);
  if (!found) {
    throw new Error(`内置 skill "${slug}" 文件未找到`);
  }
  const content = loadSkillContent(found.path) ?? "";
  // Reuse buildUserSkillContent to regenerate frontmatter consistently.
  const body = stripFrontmatter(content);
  return createSkill(userId, { name: slug, description: found.description, content: body });
}

/** Strip a leading frontmatter block, returning just the markdown body. */
function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\s*\n.*?\n---\s*\n?(.*)$/s);
  return match ? match[1].trim() : raw.trim();
}
