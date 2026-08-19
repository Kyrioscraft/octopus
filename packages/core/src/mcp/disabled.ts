/**
 * Persistent store of MCP server names the user has disabled.
 * Stored in ~/.deepagents/config.json under "mcp_disabled.servers".
 * Equivalent to Python `cortex.mcp_disabled`.
 *
 * Persistence goes through the shared JsonStore (store/json-store.ts) —
 * shares one store instance with the models + sandbox domains so writes
 * invalidate each other's read caches.
 */

import { getLogger } from "../logging.js";
import { JsonStore, configStore } from "../store/json-store.js";

const logger = getLogger("mcp.disabled");

const SECTION = "mcp_disabled";
const KEY = "servers";

function _storeFor(configPath?: string): JsonStore {
  return configPath === undefined ? configStore : new JsonStore(configPath);
}

function _toSet(section: unknown): Set<string> {
  if (!section || typeof section !== "object") return new Set();
  const entries = (section as Record<string, unknown>)[KEY];
  if (!Array.isArray(entries)) return new Set();
  return new Set(entries.filter((e): e is string => typeof e === "string" && e.length > 0));
}

export function getDisabledServers(configPath?: string): Set<string> {
  try {
    return _toSet(_storeFor(configPath).readSection(SECTION));
  } catch { return new Set(); }
}

export function isServerDisabled(serverName: string, configPath?: string): boolean {
  return getDisabledServers(configPath).has(serverName);
}

export function setServerDisabled(
  serverName: string,
  disabled: boolean,
  configPath?: string,
): boolean {
  try {
    return _storeFor(configPath).updateSection<Record<string, unknown>>(SECTION, (current) => {
      const section = { ...(current ?? {}) };
      const set = _toSet(section);
      if (disabled) set.add(serverName); else set.delete(serverName);
      section[KEY] = [...set].sort();
      return section;
    });
  } catch (err) {
    logger.error(`Could not update MCP disabled servers: ${String(err)}`);
    return false;
  }
}
