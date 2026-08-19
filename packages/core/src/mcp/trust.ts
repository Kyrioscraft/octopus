/**
 * Trust store for project-level MCP server configurations.
 * Equivalent to Python `cortex.mcp_trust`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLogger } from "../logging.js";
import { DEFAULT_STATE_DIR } from "../config/constants.js";

const logger = getLogger("mcp.trust");
const STORAGE_VERSION = 1;

function _defaultStorePath(): string { return join(DEFAULT_STATE_DIR, "mcp_trust.json"); }

export function computeConfigFingerprint(configPaths: string[]): string {
  const hasher = createHash("sha256");
  for (const path of [...configPaths].sort()) {
    try { hasher.update(readFileSync(path)); }
    catch { logger.warn(`Could not read ${path} for fingerprinting`); }
  }
  return `sha256:${hasher.digest("hex")}`;
}

function _loadStore(storePath: string): Record<string, unknown> {
  try {
    if (!existsSync(storePath)) return {};
    const data = JSON.parse(readFileSync(storePath, "utf-8"));
    return (data && typeof data === "object") ? data as Record<string, unknown> : {};
  } catch (err) { logger.warn(`Could not read MCP trust store: ${String(err)}`); return {}; }
}

function _saveStore(data: Record<string, unknown>, storePath: string): boolean {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    const tmpPath = join(dirname(storePath), `.${basename(storePath)}.tmp.${Date.now()}`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, storePath);
    return true;
  } catch (err) { logger.error(`Failed to save MCP trust store: ${String(err)}`); return false; }
}

export function isProjectMcpTrusted(projectRoot: string, fingerprint: string, storePath?: string): boolean {
  const path = storePath ?? _defaultStorePath();
  const projects = _loadStore(path)["projects"];
  return (projects && typeof projects === "object") ? (projects as Record<string, unknown>)[projectRoot] === fingerprint : false;
}

export function trustProjectMcp(projectRoot: string, fingerprint: string, storePath?: string): boolean {
  const path = storePath ?? _defaultStorePath();
  const data = _loadStore(path);
  const projects: Record<string, unknown> = (typeof data["projects"] === "object" && data["projects"]) ? { ...data["projects"] as Record<string, unknown> } : {};
  projects[projectRoot] = fingerprint;
  data["version"] = STORAGE_VERSION;
  data["projects"] = projects;
  return _saveStore(data, path);
}

export function revokeProjectMcpTrust(projectRoot: string, storePath?: string): boolean {
  const path = storePath ?? _defaultStorePath();
  const data = _loadStore(path);
  const projects = data["projects"];
  if (!projects || typeof projects !== "object" || !(projectRoot in projects)) return true;
  delete (projects as Record<string, unknown>)[projectRoot];
  data["version"] = STORAGE_VERSION;
  data["projects"] = projects;
  return _saveStore(data, path);
}
