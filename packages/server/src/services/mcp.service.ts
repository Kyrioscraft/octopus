/**
 * MCP config service — orchestrates file-source + user-defined MCP views.
 *
 * Reads file-source MCP configs (read-only, via core's discoverMcpConfigs/
 * loadMcpConfig/mergeMcpConfigs) and user-defined MCP servers (DB), merges
 * them with core's pure helpers, and applies the disabled-state layer
 * (core's getDisabledServers/setServerDisabled).
 *
 * See ARCHITECTURE_PLAN.md §11.
 */

import {
  discoverMcpConfigs,
  loadMcpConfig,
  mergeMcpConfigs,
  tagFileMcpServers,
  mergeMcpEntries,
  inferTransport,
  getDisabledServers,
  setServerDisabled,
} from "@octopus/core";
import type { McpServerEntry } from "@octopus/core";
import {
  listUserMcpServers,
  getUserMcpServer,
  upsertUserMcpServer,
  deleteUserMcpServer,
} from "../db/index.js";
import { findProjectRoot } from "@octopus/core";

/** Discover + load + merge file-source MCP configs into a single server map. */
function discoverFileMcpServers(): Record<string, Record<string, unknown>> {
  const projectRoot = findProjectRoot() ?? undefined;
  const configPaths = discoverMcpConfigs(projectRoot);
  const configs = configPaths.map((p) => loadMcpConfig(p));
  const merged = mergeMcpConfigs(configs);
  return (merged["mcpServers"] as Record<string, Record<string, unknown>>) ?? {};
}

/** Convert a DB user-mcp row into a McpServerEntry (origin=user-defined). */
function dbRowToEntry(row: {
  id: string;
  name: string;
  transport: McpServerEntry["transport"];
  config: Record<string, unknown>;
}): McpServerEntry {
  return {
    name: row.name,
    origin: "user-defined",
    editable: true,
    transport: row.transport,
    config: row.config,
    enabled: true, // disabled state is applied uniformly below in listAllMcp
  };
}

/**
 * List all MCP servers (file + user-defined), merged with disabled state.
 * user-defined overrides same-named file entries.
 *
 * @param probe when true, leave status undefined (live connection probing is
 *              a heavier op — wired in Phase G via resolveAndLoadMcpTools).
 */
export function listAllMcp(userId: string, _probe = false): McpServerEntry[] {
  const disabled = getDisabledServers();
  const fileEntries = tagFileMcpServers(discoverFileMcpServers(), disabled);
  const userEntries = listUserMcpServers(userId).map(dbRowToEntry);
  // Apply disabled state to user-defined too (disabled is runtime, applies
  // to all origins).
  for (const u of userEntries) u.enabled = !disabled.has(u.name);
  return mergeMcpEntries(fileEntries, userEntries);
}

/** Get a single MCP server. */
export function getMcpDetail(userId: string, name: string): McpServerEntry | null {
  const all = listAllMcp(userId);
  return all.find((s) => s.name === name) ?? null;
}

/** Create a user-defined MCP server. */
export function createMcp(
  userId: string,
  input: {
    name: string;
    transport?: McpServerEntry["transport"];
    config: Record<string, unknown>;
  },
): McpServerEntry {
  if (!input.name?.trim()) throw new Error("MCP server 名称不能为空");
  if (getUserMcpServer(userId, input.name)) {
    throw new Error(`用户 MCP server "${input.name}" 已存在`);
  }
  const transport = input.transport ?? inferTransport(input.config);
  const id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  upsertUserMcpServer({
    id,
    userId,
    name: input.name,
    transport,
    config: input.config,
    createdAt: now,
    updatedAt: now,
  });
  return {
    name: input.name,
    origin: "user-defined",
    editable: true,
    transport,
    config: input.config,
    enabled: true,
  };
}

/** Update a user-defined MCP server (file → throws not_editable). */
export function updateMcp(
  userId: string,
  name: string,
  patch: { transport?: McpServerEntry["transport"]; config?: Record<string, unknown> },
): McpServerEntry {
  const existing = getUserMcpServer(userId, name);
  if (!existing) {
    const fileServers = discoverFileMcpServers();
    if (fileServers[name]) {
      throw new NotEditableError(name, "file");
    }
    throw new Error(`MCP server "${name}" 不存在`);
  }
  const transport = patch.transport ?? existing.transport;
  const config = patch.config ?? existing.config;
  upsertUserMcpServer({ ...existing, transport, config });
  return {
    name,
    origin: "user-defined",
    editable: true,
    transport,
    config,
    enabled: !getDisabledServers().has(name),
  };
}

/** Delete a user-defined MCP server (file → throws not_editable). */
export function deleteMcp(userId: string, name: string): void {
  const existing = getUserMcpServer(userId, name);
  if (!existing) {
    const fileServers = discoverFileMcpServers();
    if (fileServers[name]) {
      throw new NotEditableError(name, "file");
    }
    return; // idempotent
  }
  deleteUserMcpServer(userId, name);
  // Also clear any disabled state so it doesn't linger.
  setServerDisabled(name, false);
}

/**
 * Enable/disable an MCP server (any origin). Writes runtime state via core's
 * setServerDisabled (persists to config.json).
 */
export function setMcpEnabled(name: string, enabled: boolean): void {
  setServerDisabled(name, !enabled);
}

/** Thrown when a write targets a read-only (file) source. */
export class NotEditableError extends Error {
  readonly origin: string;
  readonly name_: string;
  constructor(name: string, origin: string) {
    super(`MCP server "${name}" 来自 ${origin}，不可通过界面修改，请直接编辑 .mcp.json`);
    this.name = "NotEditableError";
    this.name_ = name;
    this.origin = origin;
  }
}
