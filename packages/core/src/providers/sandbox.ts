/**
 * Sandbox configuration (config.json `sandbox` section)
 *
 * Stores provider + credentials for deepagents sandbox backends. Currently the
 * only officially-supported provider is LangSmith (LangSmithSandbox). The
 * api_key follows the same write-only convention as provider keys: stored as
 * plaintext in config.json, but callers expose only a hasCredentials flag.
 *
 * Split out of providers/index.ts so provider/model registry concerns and
 * sandbox credential persistence are independent modules. Re-exported from
 * providers/index.ts for API compatibility.
 */

import { DEFAULT_CONFIG_PATH } from "../config/constants.js";
import { getLogger } from "../logging.js";
import { JsonStore, configStore } from "../store/json-store.js";
import { resolveEnvVar } from "./index.js";

const logger = getLogger("model.config");

/** Read the sandbox section of config.json (never throws). */
export function getSandboxConfig(configPath?: string): SandboxConfig {
  const store = configPath === undefined ? configStore : new JsonStore(configPath);
  return store.readSection<SandboxConfig>("sandbox") ?? {};
}

export type SandboxProvider = "langsmith";

export interface SandboxConfig {
  /** Whether sandbox workspaces should attempt to use a real sandbox backend. */
  enabled?: boolean;
  /** Sandbox provider (only "langsmith" is built into deepagents today). */
  provider?: SandboxProvider;
  /** Plaintext API key (write-only — callers expose hasCredentials). */
  api_key?: string;
  /** Env var name to read the key from if no literal is set. */
  api_key_env?: string;
  /** LangSmith sandbox template name (optional). */
  template_name?: string;
  /** LangSmith sandbox snapshot id to boot from (optional). */
  snapshot_id?: string;
}

/** Whether a usable API key is configured (literal or resolvable env var). */
export function sandboxHasCredentials(cfg: SandboxConfig): boolean {
  if (cfg.api_key && cfg.api_key.trim()) return true;
  if (cfg.api_key_env) {
    const v = resolveEnvVar(cfg.api_key_env);
    return !!v;
  }
  // Default LangSmith env var.
  return !!resolveEnvVar("LANGSMITH_API_KEY");
}

/** Resolve the effective API key (literal > named env > LANGSMITH_API_KEY). */
export function resolveSandboxApiKey(cfg: SandboxConfig): string | undefined {
  if (cfg.api_key && cfg.api_key.trim()) return cfg.api_key.trim();
  if (cfg.api_key_env) {
    const v = resolveEnvVar(cfg.api_key_env);
    if (v) return v;
  }
  return resolveEnvVar("LANGSMITH_API_KEY");
}

/** Patch-write the sandbox section (merges into existing). */
export function saveSandboxConfig(patch: SandboxConfig, configPath?: string): boolean {
  const store = configPath === undefined ? configStore : new JsonStore(configPath);
  return store.updateSection<SandboxConfig>("sandbox", (existing) => {
    const base = existing ?? {};
    // Drop undefined patch fields so we don't null-out unrelated keys.
    const cleaned: SandboxConfig = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (cleaned as Record<string, unknown>)[k] = v;
    }
    // An empty-string api_key clears the literal.
    if (patch.api_key === "") cleaned.api_key = "";
    return { ...base, ...cleaned };
  });
}
