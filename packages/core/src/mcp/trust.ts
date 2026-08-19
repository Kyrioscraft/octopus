/**
 * Trust store for project-level MCP server configurations.
 * Equivalent to Python `cortex.mcp_trust`.
 *
 * Persistence goes through the shared JsonStore (store/json-store.ts) over
 * ~/.deepagents/.state/mcp_trust.json.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getLogger } from "../logging.js";
import { JsonStore, mcpTrustStore } from "../store/json-store.js";

const logger = getLogger("mcp.trust");
const STORAGE_VERSION = 1;

export function computeConfigFingerprint(configPaths: string[]): string {
  const hasher = createHash("sha256");
  for (const path of [...configPaths].sort()) {
    try { hasher.update(readFileSync(path)); }
    catch { logger.warn(`Could not read ${path} for fingerprinting`); }
  }
  return `sha256:${hasher.digest("hex")}`;
}

function _storeFor(storePath?: string): JsonStore {
  return storePath === undefined ? mcpTrustStore : new JsonStore(storePath);
}

export function isProjectMcpTrusted(projectRoot: string, fingerprint: string, storePath?: string): boolean {
  const projects = _storeFor(storePath).readSection<Record<string, string>>("projects");
  return projects ? projects[projectRoot] === fingerprint : false;
}

export function trustProjectMcp(projectRoot: string, fingerprint: string, storePath?: string): boolean {
  const store = _storeFor(storePath);
  return store.writeAll({
    ...store.readAll(),
    version: STORAGE_VERSION,
    projects: { ...(store.readSection<Record<string, string>>("projects") ?? {}), [projectRoot]: fingerprint },
  });
}

export function revokeProjectMcpTrust(projectRoot: string, storePath?: string): boolean {
  const store = _storeFor(storePath);
  const projects = store.readSection<Record<string, string>>("projects");
  if (!projects || !(projectRoot in projects)) return true;
  delete projects[projectRoot];
  return store.writeAll({ ...store.readAll(), version: STORAGE_VERSION, projects });
}
