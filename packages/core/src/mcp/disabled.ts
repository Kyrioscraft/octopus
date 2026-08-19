/**
 * Persistent store of MCP server names the user has disabled.
 * Stored in ~/.deepagents/config.json under "mcp_disabled.servers".
 * Equivalent to Python `cortex.mcp_disabled`.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { getLogger } from "../logging.js";
import { DEFAULT_CONFIG_PATH } from "../config/constants.js";

const logger = getLogger("mcp.disabled");

const SECTION = "mcp_disabled";
const KEY = "servers";

/** Read the full config.json, or empty object on failure. */
function _readConfig(configPath: string): Record<string, unknown> {
  try {
    if (!existsSync(configPath)) return {};
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    return (data && typeof data === "object") ? data as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Atomic JSON write with temp-file + rename. */
function _writeConfig(data: Record<string, unknown>, configPath: string): boolean {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const tmpPath = join(dirname(configPath), `.${basename(configPath)}.tmp.${Date.now()}`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    logger.error(`Could not save config: ${String(err)}`);
    return false;
  }
}

export function getDisabledServers(configPath?: string): Set<string> {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const data = _readConfig(path);
    const section = data[SECTION];
    if (!section || typeof section !== "object") return new Set();
    const entries = (section as Record<string, unknown>)[KEY];
    if (!Array.isArray(entries)) return new Set();
    return new Set(entries.filter((e): e is string => typeof e === "string" && e.length > 0));
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
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const current = getDisabledServers(path);
    if (disabled) current.add(serverName); else current.delete(serverName);
    const data = _readConfig(path);
    const section = (data[SECTION] ?? {}) as Record<string, unknown>;
    section[KEY] = [...current].sort();
    data[SECTION] = section;
    return _writeConfig(data, path);
  } catch (err) {
    logger.error(`Could not update MCP disabled servers: ${String(err)}`);
    return false;
  }
}
