/**
 * Subagent config service — orchestrates file-source + user-defined subagent views.
 *
 * Reads file-source subagents (read-only, via core's listSubagents) and
 * user-defined subagents (DB), merges them with core's pure helpers, and
 * applies the domain rule: file/project are read-only, user-defined are
 * editable. Mirrors skill.service.ts.
 *
 * NOTE: user-defined subagents managed here are NOT yet wired into the agent
 * graph runtime (agent.ts reads filesystem sources only). This service
 * provides CRUD management; runtime injection is a future iteration.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  BUILTIN_SUBAGENTS,
  listSubagents,
  tagFileSubagents,
  mergeSubagentEntries,
  findProjectRoot,
  getServerProjectContext,
} from "@octopus/core";
import type { SubagentEntry } from "@octopus/core";
import {
  listUserSubagents,
  getUserSubagent,
  upsertUserSubagent,
  deleteUserSubagent,
  listBuiltinSubagentOverrides,
  getBuiltinSubagentOverride,
  upsertBuiltinSubagentOverride,
} from "../db/index.js";

/**
 * Discover file-source subagents, replicating the directory set that agent.ts
 * uses (user ~/.deepagents/agents + project .deepagents/agents).
 */
function discoverFileSubagents() {
  const userAgentsDir = join(homedir(), ".deepagents", "agents");

  let projectAgentsDir: string | null = null;
  try {
    const ctx = getServerProjectContext();
    projectAgentsDir = ctx?.projectAgentsDir ?? null;
  } catch {
    // Fall back to a simple project-root-based path.
    const root = findProjectRoot();
    projectAgentsDir = root ? join(root, ".deepagents", "agents") : null;
  }

  return listSubagents({
    userAgentsDir: existsSync(userAgentsDir) ? userAgentsDir : null,
    projectAgentsDir: projectAgentsDir && existsSync(projectAgentsDir) ? projectAgentsDir : null,
  });
}

/** Convert a DB user-subagent row into a SubagentEntry (origin=user-defined). */
function dbRowToEntry(row: {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string | null;
  enabled: boolean;
}): SubagentEntry {
  return {
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    model: row.model,
    tools: row.tools,
    origin: "user-defined",
    editable: true,
    enabled: row.enabled,
    source: "user-defined",
    path: row.id,
  };
}

/**
 * List all subagents (file + user-defined), merged. user-defined overrides
 * same-named file entries.
 */
export function listAllSubagents(userId: string): SubagentEntry[] {
  const fileSubagents = tagFileSubagents(discoverFileSubagents());
  const userSubagents = listUserSubagents(userId).map(dbRowToEntry);
  return mergeSubagentEntries(fileSubagents, userSubagents);
}

// =============================================================================
// Built-in subagent model overrides
//
// Built-ins (Explore, general-purpose) have no enable/disable or delete — they
// are always enabled. The only user-tunable knob is a per-user model override
// (null = inherit the default model), persisted in builtin_subagent_overrides.
// =============================================================================

/** All built-in subagent entries for a user, with their model overrides applied. */
export function listBuiltinSubagents(userId: string): SubagentEntry[] {
  const overrides = new Map(
    listBuiltinSubagentOverrides(userId).map((r) => [r.name, r.model]),
  );
  return BUILTIN_SUBAGENTS.map((b) => ({
    name: b.name,
    description: b.description,
    systemPrompt: b.systemPrompt,
    model: overrides.get(b.name) ?? b.model ?? null,
    tools: b.tools ?? [],
    origin: "builtin" as const,
    editable: false,
    enabled: true,
    source: "builtin",
  }));
}

/**
 * Override a built-in subagent's model. @throws when the name is not built-in.
 */
export function setBuiltinSubagentModel(
  userId: string,
  name: string,
  model: string | null,
): SubagentEntry {
  const builtin = BUILTIN_SUBAGENTS.find((b) => b.name === name);
  if (!builtin) throw new Error(`子智能体 "${name}" 不是内置子智能体`);
  const model_ = model?.trim() ? model.trim() : null;
  upsertBuiltinSubagentOverride(userId, name, model_);
  return {
    name: builtin.name,
    description: builtin.description,
    systemPrompt: builtin.systemPrompt,
    model: model_,
    tools: builtin.tools ?? [],
    origin: "builtin",
    editable: false,
    enabled: true,
    source: "builtin",
  };
}

/** Resolve a user's built-in overrides into the shape makeGraph expects. */
export function resolveBuiltinOverrides(userId: string): Record<string, string | null> {
  const overrides: Record<string, string | null> = {};
  for (const r of listBuiltinSubagentOverrides(userId)) {
    overrides[r.name] = r.model;
  }
  return overrides;
}

/** Get a single subagent's detail. */
export function getSubagentDetail(userId: string, name: string): SubagentEntry | null {
  // user-defined first (highest precedence)
  const userSubagent = getUserSubagent(userId, name);
  if (userSubagent) {
    return dbRowToEntry(userSubagent);
  }
  // file/project
  const fileSubagents = discoverFileSubagents();
  const found = fileSubagents.find((s) => s.name === name);
  if (found) {
    return {
      name: found.name,
      description: found.description,
      systemPrompt: found.systemPrompt,
      model: found.model ?? null,
      tools: [],
      origin: "file",
      editable: false,
      enabled: true,
      source: found.source,
      path: found.path,
    };
  }
  // Built-in fallback (Explore, general-purpose) with the user's model
  // override applied.
  const builtin = listBuiltinSubagents(userId).find((s) => s.name === name);
  return builtin ?? null;
}

/** Create a user-defined subagent. @throws on invalid name or conflict. */
export function createSubagent(
  userId: string,
  input: {
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[];
    model?: string | null;
  },
): SubagentEntry {
  if (!input.name?.trim()) throw new Error("名称不能为空");
  if (!input.systemPrompt?.trim()) throw new Error("系统提示词不能为空");
  if (getUserSubagent(userId, input.name)) {
    throw new Error(`子智能体 "${input.name}" 已存在`);
  }
  const id = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  upsertUserSubagent({
    id,
    userId,
    name: input.name,
    description: input.description ?? "",
    systemPrompt: input.systemPrompt,
    tools: input.tools ?? [],
    model: input.model ?? null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return dbRowToEntry({
    id,
    name: input.name,
    description: input.description ?? "",
    systemPrompt: input.systemPrompt,
    tools: input.tools ?? [],
    model: input.model ?? null,
    enabled: true,
  });
}

/** Update a user-defined subagent (file → throws not_editable). */
export function updateSubagent(
  userId: string,
  name: string,
  patch: {
    description?: string;
    systemPrompt?: string;
    tools?: string[];
    model?: string | null;
  },
): SubagentEntry {
  const existing = getUserSubagent(userId, name);
  if (!existing) {
    // Built-in entries (Explore, general-purpose): only the model may be
    // overridden — any other field is rejected.
    if (BUILTIN_SUBAGENTS.some((b) => b.name === name)) {
      const hasOther =
        patch.description !== undefined ||
        patch.systemPrompt !== undefined ||
        patch.tools !== undefined;
      if (hasOther) {
        throw new Error("内置子智能体仅支持修改模型");
      }
      return setBuiltinSubagentModel(userId, name, patch.model ?? null);
    }
    const fileSubagents = discoverFileSubagents();
    if (fileSubagents.some((s) => s.name === name)) {
      throw new NotEditableError(name, "file");
    }
    throw new Error(`子智能体 "${name}" 不存在`);
  }
  const updated = {
    ...existing,
    description: patch.description ?? existing.description,
    systemPrompt: patch.systemPrompt ?? existing.systemPrompt,
    tools: patch.tools ?? existing.tools,
    // model: only overwrite when the key was explicitly provided (allows null to clear)
    model: patch.model !== undefined ? patch.model : existing.model,
  };
  upsertUserSubagent(updated);
  return dbRowToEntry(updated);
}

/** Delete a user-defined subagent (file → throws not_editable). */
export function deleteSubagent(userId: string, name: string): void {
  const existing = getUserSubagent(userId, name);
  if (!existing) {
    const fileSubagents = discoverFileSubagents();
    if (fileSubagents.some((s) => s.name === name)) {
      throw new NotEditableError(name, "file");
    }
    // Idempotent: deleting a non-existent subagent is a no-op.
    return;
  }
  deleteUserSubagent(userId, name);
}

/** Enable/disable a user-defined subagent at runtime. */
export function setSubagentEnabled(userId: string, name: string, enabled: boolean): boolean {
  const existing = getUserSubagent(userId, name);
  if (!existing) {
    throw new Error(`子智能体 "${name}" 不存在`);
  }
  upsertUserSubagent({ ...existing, enabled });
  return enabled;
}

/** Thrown when a write targets a read-only (file/project) source. */
export class NotEditableError extends Error {
  readonly origin: string;
  readonly name_: string;
  constructor(name: string, origin: string) {
    super(`子智能体 "${name}" 来自 ${origin}，不可通过界面修改`);
    this.name = "NotEditableError";
    this.name_ = name;
    this.origin = origin;
  }
}
