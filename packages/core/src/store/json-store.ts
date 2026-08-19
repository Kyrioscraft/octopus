/**
 * JsonStore — single-owner atomic JSON persistence.
 *
 * Previously four independent copies of tmp-file+rename read-modify-write
 * lived in providers/index.ts, providers/sandbox.ts, mcp/disabled.ts and
 * mcp/trust.ts. This module is the single implementation: every domain
 * (model config, sandbox credentials, MCP disabled servers, MCP trust
 * fingerprints) persists through a JsonStore instance over its own file.
 *
 * Guarantees:
 *   - Atomic writes: temp file + rename, never a torn file on crash.
 *   - Section isolation: callers read/patch their own JSON section without
 *     clobbering unrelated keys in a shared file (config.json hosts several
 *     domains side by side).
 *   - Read cache with explicit invalidation on every write through THIS
 *     store instance (per-process; cross-process coordination is out of
 *     scope, same as before).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLogger } from "../logging.js";

const logger = getLogger("store.json");

export class JsonStore {
  readonly path: string;
  #cache: Record<string, unknown> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Read the whole file ({} when missing or invalid JSON). Cached. */
  readAll(): Record<string, unknown> {
    if (this.#cache !== null) return this.#cache;
    this.#cache = this.#readOrEmpty();
    return this.#cache;
  }

  /** Read one top-level section (undefined when absent). */
  readSection<T>(key: string): T | undefined {
    return this.readAll()[key] as T | undefined;
  }

  /**
   * Read-modify-write one top-level section. `update` receives the current
   * value (or undefined) and returns the new value; returning undefined
   * deletes the section. Other sections are untouched.
   */
  updateSection<T>(key: string, update: (current: T | undefined) => T | undefined): boolean {
    const data = { ...this.#readOrEmpty() };
    const next = update(data[key] as T | undefined);
    if (next === undefined) {
      delete data[key];
    } else {
      data[key] = next;
    }
    return this.#write(data);
  }

  /** Atomically replace the whole file. */
  writeAll(data: Record<string, unknown>): boolean {
    return this.#write(data);
  }

  /** Drop the read cache so the next read hits the disk. */
  invalidate(): void {
    this.#cache = null;
  }

  #readOrEmpty(): Record<string, unknown> {
    try {
      if (existsSync(this.path)) {
        return JSON.parse(readFileSync(this.path, "utf-8"));
      }
    } catch {
      // Invalid JSON → start fresh (matches the previous per-module behavior)
    }
    return {};
  }

  #write(data: Record<string, unknown>): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmpPath = join(dirname(this.path), `.${basename(this.path)}.tmp.${Date.now()}`);
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, this.path);
      this.#cache = data;
      return true;
    } catch (err) {
      logger.error(`Could not save config to ${this.path}: ${String(err)}`);
      return false;
    }
  }
}

// =============================================================================
// Shared store instances — one per persisted file. Domains that share
// config.json (models, sandbox, mcp-disabled) MUST share the same instance
// so a write in one domain invalidates the cache for the others.
// =============================================================================

import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_DIR } from "../config/constants.js";
import { join as joinPath } from "node:path";

/** The ~/.deepagents/config.json shared store (models + sandbox + mcp_disabled). */
export const configStore = new JsonStore(DEFAULT_CONFIG_PATH);

/** The ~/.deepagents/.state/mcp_trust.json store (project trust fingerprints). */
export const mcpTrustStore = new JsonStore(joinPath(DEFAULT_STATE_DIR, "mcp_trust.json"));
