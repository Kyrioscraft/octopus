/**
 * ModelConfig — configuration reader for ~/.deepagents/config.json.
 *
 * Equivalent to Python `cortex.model_config.ModelConfig` (core read path only).
 * JSON format — nested objects instead of TOML sections.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  ENV_PREFIX,
  PROVIDER_API_KEY_ENV,
  PROVIDER_BASE_URL_ENV,
} from "./constants.js";
import { getLogger } from "./logging.js";

const logger = getLogger("model.config");

// =============================================================================
// Types
// =============================================================================

/** Per-provider configuration from config.json `models.providers.<name>`. */
export interface ProviderConfig {
  enabled?: boolean;
  models?: string[];
  api_key_env?: string;
  base_url?: string;
  base_url_env?: string;
  class_path?: string;
  params?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  /** Direct API key value (highest priority, overrides api_key_env). */
  api_key?: string;
  /** Friendly display name (defaults to the provider key). */
  display_name?: string;
  /** Protocol/SDK type, e.g. openai / anthropic / ollama / openai-compatible. */
  api_type?: string;
}

/** Parsed config.json model section. */
export interface ModelConfigData {
  default_model?: string;
  recent_model?: string;
  providers: Record<string, ProviderConfig>;
}

// =============================================================================
// Env var resolution — equivalent to Python `resolve_env_var()`.
// =============================================================================

export function resolveEnvVar(name: string): string | undefined {
  if (!name.startsWith(ENV_PREFIX)) {
    const prefixed = `${ENV_PREFIX}${name}`;
    if (prefixed in process.env) {
      return process.env[prefixed] || undefined;
    }
  }
  return process.env[name] || undefined;
}

// =============================================================================
// Internal helpers
// =============================================================================

let _configCache: ModelConfigData | null = null;

/** Load the full config.json file. Cached, pass forceReload to bypass. */
function _loadFullConfig(configPath?: string, forceReload = false): Record<string, unknown> {
  const isDefault = configPath === undefined;
  if (isDefault && _configCache !== null && !forceReload) {
    // Return a reconstructed full config from the cache
    return { models: { ..._configCache } };
  }

  const path = configPath ?? DEFAULT_CONFIG_PATH;

  // File missing → return empty config WITHOUT caching (allows re-check later)
  if (!existsSync(path)) {
    logger.debug(`Config file not found at ${path} — using defaults.`);
    return {};
  }

  // Parse JSON
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    logger.warn(
      `Config file ${path} has invalid JSON syntax: ${String(e)}. ` +
      "Ignoring config file. Fix the file or delete it to reset.",
    );
    // Don't cache the error result — allow retry after user fixes the file
    return {};
  }

  return raw;
}

// =============================================================================
// ModelConfig — the main config facade.
// =============================================================================

export const ModelConfig = {
  load(configPath?: string, forceReload = false): ModelConfigData {
    const raw = _loadFullConfig(configPath, forceReload);
    const models = (raw["models"] ?? {}) as Record<string, unknown>;

    const config: ModelConfigData = {
      default_model: models["default"] as string | undefined,
      recent_model: models["recent"] as string | undefined,
      providers: (models["providers"] ?? {}) as Record<string, ProviderConfig>,
    };

    const isDefault = configPath === undefined;
    if (isDefault) _configCache = config;
    return config;
  },

  isProviderEnabled(providerName: string): boolean {
    const config = this.load();
    const provider = config.providers[providerName];
    if (!provider || provider.enabled === undefined) return true;
    return provider.enabled !== false;
  },

  getApiKeyEnv(providerName: string): string | undefined {
    const config = this.load();
    const provider = config.providers[providerName];
    if (provider?.api_key_env) return provider.api_key_env;
    return PROVIDER_API_KEY_ENV[providerName];
  },

  /**
   * Get the resolved API key for a provider.
   *
   * Resolution order:
   * 1. config.json `api_key` (direct value, highest)
   * 2. Env var from `api_key_env` or `PROVIDER_API_KEY_ENV` registry
   */
  getApiKey(providerName: string): string | undefined {
    const config = this.load();
    const provider = config.providers[providerName];

    // 1. Direct api_key in config.json
    if (provider?.api_key) return provider.api_key;

    // 2. Env var resolution
    const envName = this.getApiKeyEnv(providerName);
    if (envName) return resolveEnvVar(envName);
    return undefined;
  },

  getBaseUrl(providerName: string): string | undefined {
    const config = this.load();
    const provider = config.providers[providerName];

    if (provider?.base_url) return provider.base_url;

    if (provider?.base_url_env) {
      const val = resolveEnvVar(provider.base_url_env);
      if (val) return val;
    }

    const names = PROVIDER_BASE_URL_ENV[providerName];
    if (names && names.length > 0) {
      const val = resolveEnvVar(names[0]);
      if (val) return val;
    }

    return undefined;
  },

  hasCredentials(providerName: string): boolean | undefined {
    const apiKeyEnv = this.getApiKeyEnv(providerName);
    if (apiKeyEnv) {
      const val = resolveEnvVar(apiKeyEnv);
      if (val) return true;
      if (apiKeyEnv in process.env) return false;
    }
    return undefined;
  },

  getKwargs(providerName: string, modelName?: string): Record<string, unknown> {
    const config = this.load();
    const provider = config.providers[providerName];
    if (!provider?.params) return {};

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(provider.params)) {
      if (typeof value !== "object" || value === null) {
        result[key] = value;
      }
    }

    if (modelName) {
      const overrides = provider.params[modelName];
      if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
        Object.assign(result, overrides);
      }
    }

    return result;
  },

  getProfileOverrides(providerName: string, modelName?: string): Record<string, unknown> {
    const config = this.load();
    const provider = config.providers[providerName];
    if (!provider?.profile) return {};

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(provider.profile)) {
      if (typeof value !== "object" || value === null) {
        result[key] = value;
      }
    }

    if (modelName) {
      const overrides = provider.profile[modelName];
      if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
        Object.assign(result, overrides);
      }
    }

    return result;
  },
};

// =============================================================================
// Config file writers — JSON read-modify-write with temp file + rename.
// =============================================================================

function _readConfigOrEmpty(configPath: string): Record<string, unknown> {
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Invalid JSON → start fresh
  }
  return {};
}

function _writeConfig(data: Record<string, unknown>, configPath: string): boolean {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const tmpPath = join(dirname(configPath), `.${basename(configPath)}.tmp.${Date.now()}`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, configPath);
    _configCache = null;
    return true;
  } catch (err) {
    logger.error(`Could not save config to ${configPath}: ${String(err)}`);
    return false;
  }
}

export function saveDefaultModel(modelSpec: string, configPath?: string): boolean {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const data = _readConfigOrEmpty(path);
  const models = (data["models"] ?? {}) as Record<string, unknown>;
  models["default"] = modelSpec;
  data["models"] = models;
  return _writeConfig(data, path);
}

export function saveRecentModel(modelSpec: string, configPath?: string): boolean {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const data = _readConfigOrEmpty(path);
  const models = (data["models"] ?? {}) as Record<string, unknown>;
  models["recent"] = modelSpec;
  data["models"] = models;
  return _writeConfig(data, path);
}

export function clearDefaultModel(configPath?: string): boolean {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const data = _readConfigOrEmpty(path);
  const models = data["models"] as Record<string, unknown> | undefined;
  if (models) {
    delete models["default"];
    if (Object.keys(models).length === 0) {
      delete data["models"];
    }
  }
  return _writeConfig(data, path);
}

// =============================================================================
// Provider overview + per-provider config writers
// =============================================================================

/** Overview row for a single model provider (no secrets surfaced). */
export interface ProviderOverview {
  name: string;
  /** Friendly display name (falls back to `name`). */
  displayName: string;
  /** Protocol/SDK type if set, else null. */
  apiType: string | null;
  enabled: boolean;
  /** `true` if a key is set, `false` if a key env is known but empty, `undefined` if unknown. */
  hasCredentials: boolean | undefined;
  apiKeyEnv: string | undefined;
  baseUrl: string | undefined;
  models: string[];
  /** Whether this provider is in the built-in registry (vs user-defined). */
  builtIn: boolean;
}

/**
 * List every known provider (from `PROVIDER_API_KEY_ENV`) merged with any
 * user-defined providers in config.json, returning a secret-free overview.
 *
 * Equivalent to Python `cortex.model_config.list_providers` (overview form).
 */
export function listProvidersOverview(configPath?: string): ProviderOverview[] {
  const config = ModelConfig.load(configPath, true);
  const seen = new Set<string>();
  const rows: ProviderOverview[] = [];

  // Known-provider universe first (stable ordering by registry key order)
  for (const name of Object.keys(PROVIDER_API_KEY_ENV)) {
    seen.add(name);
    rows.push(_providerOverviewRow(name, config, true));
  }
  // Any extra user-defined providers not in the registry
  for (const name of Object.keys(config.providers)) {
    if (!seen.has(name)) {
      rows.push(_providerOverviewRow(name, config, false));
    }
  }
  return rows;
}

function _providerOverviewRow(name: string, config: ModelConfigData, builtIn: boolean): ProviderOverview {
  const provider = config.providers[name];
  return {
    name,
    displayName: provider?.display_name ?? name,
    apiType: provider?.api_type ?? null,
    enabled: provider?.enabled === undefined ? true : provider.enabled !== false,
    hasCredentials: ModelConfig.hasCredentials(name),
    apiKeyEnv: ModelConfig.getApiKeyEnv(name),
    baseUrl: ModelConfig.getBaseUrl(name),
    models: provider?.models ?? [],
    builtIn,
  };
}

/** Fields that may be patched on a provider. `undefined` = leave unchanged. */
export interface ProviderConfigPatch {
  enabled?: boolean;
  /** Direct API key value written to config.json (overrides `api_key_env`). */
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  models?: string[];
  /** Friendly display name. */
  displayName?: string;
  /** Protocol/SDK type (openai / anthropic / ollama / openai-compatible ...). */
  apiType?: string;
  /**
   * New provider key. When set and different from the current key, the entire
   * config entry is migrated to the new key (a rename). An empty target is
   * rejected.
   */
  newName?: string;
}

/**
 * Read-modify-write a single provider's config in config.json.
 *
 * Setting `apiKey` writes the literal value under `api_key`; pass `null` to
 * clear it. `models` replaces the array. `newName` (if different) migrates the
 * entry to a new key. Always invalidates the read cache.
 *
 * Equivalent to Python `cortex.model_config.save_provider_config`.
 *
 * @returns the (possibly renamed) provider key written.
 */
export function saveProviderConfig(
  providerName: string,
  patch: ProviderConfigPatch,
  configPath?: string,
): string {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const data = _readConfigOrEmpty(path);
  const models = (data["models"] ?? {}) as Record<string, unknown>;
  const providers = ((models["providers"] ?? {}) as Record<string, unknown>) as Record<
    string,
    ProviderConfig
  >;
  const provider: ProviderConfig = providers[providerName] ?? {};

  if (patch.enabled !== undefined) provider.enabled = patch.enabled;
  if (patch.apiKeyEnv !== undefined) provider.api_key_env = patch.apiKeyEnv;
  if (patch.baseUrl !== undefined) provider.base_url = patch.baseUrl;
  if (patch.models !== undefined) provider.models = patch.models;
  if (patch.displayName !== undefined) provider.display_name = patch.displayName;
  if (patch.apiType !== undefined) provider.api_type = patch.apiType;
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === "") {
      delete provider.api_key;
    } else {
      provider.api_key = patch.apiKey;
    }
  }

  // Determine the final key (handle rename).
  let finalKey = providerName;
  if (patch.newName !== undefined) {
    const target = patch.newName.trim();
    if (target === "") {
      throw new Error("供应商名称不能为空");
    }
    finalKey = target;
  }

  // Write under the (possibly new) key; remove the old key on rename.
  if (finalKey !== providerName) {
    delete providers[providerName];
  }
  providers[finalKey] = provider;
  models["providers"] = providers;
  data["models"] = models;
  _writeConfig(data, path);
  return finalKey;
}

// =============================================================================
// Sandbox configuration (config.json `sandbox` section)
//
// Stores provider + credentials for deepagents sandbox backends. Currently the
// only officially-supported provider is LangSmith (LangSmithSandbox). The
// api_key follows the same write-only convention as provider keys: stored as
// plaintext in config.json, but callers expose only a hasCredentials flag.
// =============================================================================

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

/** Read the sandbox section of config.json (never throws). */
export function getSandboxConfig(configPath?: string): SandboxConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const data = _readConfigOrEmpty(path);
  const sandbox = data["sandbox"] as SandboxConfig | undefined;
  return sandbox ?? {};
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
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const data = _readConfigOrEmpty(path);
  const existing = (data["sandbox"] ?? {}) as SandboxConfig;
  // Drop undefined patch fields so we don't null-out unrelated keys.
  const cleaned: SandboxConfig = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (cleaned as Record<string, unknown>)[k] = v;
  }
  // An empty-string api_key clears the literal.
  if (patch.api_key === "") cleaned.api_key = "";
  data["sandbox"] = { ...existing, ...cleaned };
  return _writeConfig(data, path);
}

// =============================================================================
// Cache management
// =============================================================================

export function clearCaches(): void {
  _configCache = null;
}
