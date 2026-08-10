/**
 * Slash-command config service — merges built-in + user-defined commands.
 *
 * Built-in commands come from core's BUILTIN_SLASH_COMMANDS and are tagged with
 * a `platform` field ("web" | "tui" | "all"). User-defined commands live in the
 * SQLite DB. Same-name user-defined commands shadow (override) built-in ones.
 */

import { randomUUID } from "node:crypto";
import { BUILTIN_SLASH_COMMANDS } from "@octopus/core";
import type { BuiltinSlashCommand } from "@octopus/core";
import {
  listUserSlashCommands,
  getUserSlashCommand,
  upsertUserSlashCommand,
  deleteUserSlashCommand,
} from "../db/index.js";
import type { UserSlashCommandRow } from "../db/index.js";

// =============================================================================
// Public types (matched to tentacle's SlashCommandEntry)
// =============================================================================

export type SlashCommandKind = "system" | "prompt";
export type SlashCommandOrigin = "builtin" | "user-defined";
export type SlashCommandPlatform = "web" | "tui" | "all";

export type SystemAction =
  | "clear" | "theme" | "help" | "copy-last" | "search"
  | "changelog" | "version" | "feedback" | "docs"
  | { type: "navigate"; path: string }
  | "model" | "agents" | "editor" | "quit" | "notifications"
  | "threads" | "update" | "install" | "auto-update"
  | "tokens" | "trace" | "offload" | "remember" | "skill-creator";

export interface SlashCommandEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  kind: SlashCommandKind;
  systemAction?: SystemAction | null;
  promptTemplate?: string | null;
  action?: "insert" | "send" | null;
  origin: SlashCommandOrigin;
  editable: boolean;
  platform?: SlashCommandPlatform | null;
  category?: string | null;
}

export interface SlashCommandWriteRequest {
  name?: string;
  displayName?: string;
  description?: string;
  promptTemplate?: string;
  action?: "insert" | "send";
  category?: string | null;
}

// =============================================================================
// Map helpers
// =============================================================================

function builtinToEntry(b: BuiltinSlashCommand, id: string): SlashCommandEntry {
  return {
    id,
    name: b.name,
    displayName: b.displayName,
    description: b.description,
    kind: b.kind,
    ...(b.kind === "system"
      ? { systemAction: b.systemAction ?? null }
      : {
          promptTemplate: b.promptTemplate ?? null,
          action: b.promptAction ?? "insert",
        }),
    origin: "builtin",
    editable: false,
    platform: b.platform,
    category: b.category ?? null,
  };
}

function userToEntry(r: UserSlashCommandRow): SlashCommandEntry {
  return {
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    kind: "prompt",
    promptTemplate: r.promptTemplate,
    action: r.action,
    origin: "user-defined",
    editable: true,
    platform: null,
    category: r.category ?? null,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * List slash commands (merged: user-defined shadow same-name builtins).
 * Pass `platform` to filter built-in commands to a specific target.
 */
export function listAllCommands(
  userId: string,
  platform?: SlashCommandPlatform,
): SlashCommandEntry[] {
  const userCommands = listUserSlashCommands(userId);
  const userNames = new Set(userCommands.map((c) => c.name));

  // Built-in commands: filter by platform if requested, then exclude
  // any that are shadowed by user-defined commands.
  let builtins = BUILTIN_SLASH_COMMANDS;
  if (platform) {
    builtins = builtins.filter(
      (b) => b.platform === platform || b.platform === "all",
    );
  }
  const builtinEntries = builtins
    .filter((b) => !userNames.has(b.name))
    .map((b) => builtinToEntry(b, `builtin_${b.name}`));

  // User-defined first (higher priority in the menu).
  const userEntries = userCommands.map(userToEntry);

  return [...userEntries, ...builtinEntries];
}

/**
 * Get a single command by id.
 */
export function getCommand(userId: string, id: string): SlashCommandEntry | undefined {
  // Check user-defined first.
  const userCmd = getUserSlashCommand(userId, id);
  if (userCmd) return userToEntry(userCmd);

  // Built-in fallback.
  if (id.startsWith("builtin_")) {
    const name = id.slice("builtin_".length);
    const builtin = BUILTIN_SLASH_COMMANDS.find((b) => b.name === name);
    if (builtin) return builtinToEntry(builtin, id);
  }
  const builtinByName = BUILTIN_SLASH_COMMANDS.find((b) => b.name === id);
  if (builtinByName) return builtinToEntry(builtinByName, `builtin_${id}`);

  return undefined;
}

/**
 * Create a user-defined slash command.
 */
export function createCommand(
  userId: string,
  body: SlashCommandWriteRequest,
): SlashCommandEntry {
  if (!body.name?.trim()) throw new Error("命令名不能为空");
  if (!body.displayName?.trim()) throw new Error("显示名不能为空");

  const name = body.name.trim();
  const existingUser = listUserSlashCommands(userId).find((c) => c.name === name);
  if (existingUser) throw new Error("同名命令已存在");

  const now = new Date().toISOString();
  const row: UserSlashCommandRow = {
    id: randomUUID(),
    userId,
    name,
    displayName: body.displayName.trim(),
    description: body.description?.trim() ?? "",
    promptTemplate: body.promptTemplate?.trim() ?? "",
    action: body.action ?? "insert",
    category: body.category?.trim() || null,
    icon: null,
    createdAt: now,
    updatedAt: now,
  };
  upsertUserSlashCommand(row);
  return userToEntry(row);
}

/**
 * Update a user-defined slash command.
 */
export function updateCommand(
  userId: string,
  id: string,
  body: SlashCommandWriteRequest,
): SlashCommandEntry {
  const existing = getUserSlashCommand(userId, id);
  if (!existing) throw new Error("命令不存在");

  const now = new Date().toISOString();
  const updated: UserSlashCommandRow = {
    ...existing,
    displayName: body.displayName?.trim() ?? existing.displayName,
    description: body.description?.trim() ?? existing.description,
    promptTemplate: body.promptTemplate?.trim() ?? existing.promptTemplate,
    action: body.action ?? existing.action,
    category: body.category !== undefined ? (body.category?.trim() || null) : existing.category,
    updatedAt: now,
  };
  if (body.name?.trim() && body.name.trim() !== existing.name) {
    const nameCollision = listUserSlashCommands(userId).find(
      (c) => c.name === body.name!.trim() && c.id !== id,
    );
    if (nameCollision) throw new Error("同名命令已存在");
    updated.name = body.name.trim();
  }

  upsertUserSlashCommand(updated);
  return userToEntry(updated);
}

/**
 * Delete a user-defined slash command.
 */
export function deleteCommand(userId: string, id: string): void {
  const existing = getUserSlashCommand(userId, id);
  if (!existing) throw new Error("命令不存在");
  deleteUserSlashCommand(userId, id);
}
