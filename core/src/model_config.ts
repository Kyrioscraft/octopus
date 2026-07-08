/**
 * ModelConfig — configuration reader for ~/.deepagents/config.toml.
 *
 * Equivalent to Python `cortex.model_config.ModelConfig` (core read path only).
 * Omitted from the Python original (3184 lines):
 *   - OAuth credential storage / apply_stored_credentials
 *   - Ollama local model discovery
 *   - get_available_models() (provider profile enumeration)
 *   - ProviderAuthStatus / get_provider_auth_status() (detailed status UI)
 *   - Interpreter / warnings / threads / agents sections (read elsewhere)
 *   - get_class_path() / _create_model_from_class() (custom model class loading)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseTOML } from "smol-toml";
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

/** Per-provider configuration from config.toml `[models.providers.<name>]`. */
export interface ProviderConfig {
  /** Whether this provider appears in the model switcher (defaults to true). */
  enabled?: boolean;
  /** List of model identifiers available from this provider. */
  models?: string[];
  /** Name of the environment variable holding the API key. */
  api_key_env?: string;
  /** Custom base URL (highest priority for endpoint resolution). */
  base_url?: string;
  /** Name of the environment variable holding this provider's base URL. */
  base_url_env?: string;
  /** Fully-qualified class path for custom chat model (not implemented in TS). */
  class_path?: string;
  /** Extra keyword arguments forwarded to the model constructor. */
  params?: Record<string, unknown>;
  /** Profile overrides merged into the model's runtime profile dict. */
  profile?: Record<string, unknown>;
}

/** Parsed config.toml model section. */
export interface ModelConfigData {
  /** `[models].default` — the user's intentional default model (provider:model). */
  default_model?: string;
  /** `[models].recent` — the most recently switched-to model. */
  recent_model?: string;
  /** `[models.providers]` — per-provider configuration. */
  providers: Record<string, ProviderConfig>;
}

// =============================================================================
// Env var resolution — equivalent to Python `resolve_env_var()`.
// =============================================================================

/**
 * Resolve an environment variable with `DEEPAGENTS_CODE_` prefix override.
 *
 * If `DEEPAGENTS_CODE_{NAME}` is *present* in the environment (even as an
 * empty string), the canonical `{NAME}` is **never consulted**. An empty
 * prefixed var can be used to suppress the canonical value.
 *
 * Equivalent to Python `cortex.model_config.resolve_env_var`.
 */
export function resolveEnvVar(name: string): string | undefined {
  if (!name.startsWith(ENV_PREFIX)) {
    const prefixed = `${ENV_PREFIX}${name}`;
    if (prefixed in process.env) {
      return process.env[prefixed] || undefined; // empty string → undefined
    }
  }
  return process.env[name] || undefined;
}

// =============================================================================
// ModelConfig — the main config facade.
// =============================================================================

/** Module-level cache for the default config (lazy-loaded once). */
let _configCache: ModelConfigData | null = null;

/**
 * Parsed config.toml model section with accessor methods.
 *
 * Use `ModelConfig.load()` to get a cached instance. The raw data is exposed
 * as a plain object; helper methods below provide the same lookup logic as
 * the Python original.
 */
export const ModelConfig = {
  /**
   * Load config from `~/.deepagents/config.toml`.
   *
   * Results are cached globally; subsequent calls return the cached value.
   * Pass `forceReload = true` to bypass the cache.
   *
   * Equivalent to Python `ModelConfig.load()`.
   */
  load(configPath?: string, forceReload = false): ModelConfigData {
    const isDefault = configPath === undefined;
    if (isDefault && _configCache !== null && !forceReload) {
      return _configCache;
    }

    const path = configPath ?? DEFAULT_CONFIG_PATH;

    // File missing → return empty config
    if (!existsSync(path)) {
      const fallback: ModelConfigData = { providers: {} };
      if (isDefault) _configCache = fallback;
      return fallback;
    }

    // Parse TOML
    let raw: Record<string, unknown>;
    try {
      raw = parseTOML(readFileSync(path, "utf-8"));
    } catch (e) {
      logger.warn(
        `Config file ${path} has invalid TOML syntax: ${String(e)}. ` +
        "Ignoring config file. Fix the file or delete it to reset.",
      );
      const fallback: ModelConfigData = { providers: {} };
      if (isDefault) _configCache = fallback;
      return fallback;
    }

    const models = (raw["models"] ?? {}) as Record<string, unknown>;

    const config: ModelConfigData = {
      default_model: models["default"] as string | undefined,
      recent_model: models["recent"] as string | undefined,
      providers: (models["providers"] ?? {}) as Record<string, ProviderConfig>,
    };

    if (isDefault) _configCache = config;
    return config;
  },

  // -- Provider-level accessors (equivalent to Python ModelConfig methods) --

  /**
   * Check whether a provider is enabled (visible in the model switcher).
   *
   * A provider is disabled only when its config explicitly sets `enabled = false`.
   * Providers not present in the config file are always considered enabled.
   */
  isProviderEnabled(providerName: string): boolean {
    const config = ModelConfig.load();
    const provider = config.providers[providerName];
    if (!provider || provider.enabled === undefined) return true;
    return provider.enabled !== false;
  },

  /**
   * Get the API key env var name for a provider.
   *
   * Resolution order:
   * 1. Config-file `api_key_env` (user-customized)
   * 2. Hardcoded `PROVIDER_API_KEY_ENV` registry
   *
   * Equivalent to Python `ModelConfig.get_api_key_env()`.
   */
  getApiKeyEnv(providerName: string): string | undefined {
    const config = ModelConfig.load();
    const provider = config.providers[providerName];
    if (provider?.api_key_env) return provider.api_key_env;
    return PROVIDER_API_KEY_ENV[providerName];
  },

  /**
   * Get the base URL for a provider.
   *
   * Resolution order:
   * 1. Config-file `base_url`
   * 2. Env var from `base_url_env` or `PROVIDER_BASE_URL_ENV` canonical name
   *
   * Equivalent to Python `ModelConfig.get_base_url()`.
   */
  getBaseUrl(providerName: string): string | undefined {
    const config = ModelConfig.load();
    const provider = config.providers[providerName];

    // 1. Explicit base_url in config.toml
    if (provider?.base_url) return provider.base_url;

    // 2. base_url_env in config.toml (user-customized)
    if (provider?.base_url_env) {
      const val = resolveEnvVar(provider.base_url_env);
      if (val) return val;
    }

    // 3. Hardcoded PROVIDER_BASE_URL_ENV canonical name
    const names = PROVIDER_BASE_URL_ENV[providerName];
    if (names && names.length > 0) {
      const val = resolveEnvVar(names[0]);
      if (val) return val;
    }

    return undefined;
  },

  /**
   * Check whether a provider has credentials configured.
   *
   * Returns `true` if the API key env var is set (via `resolveEnvVar`),
   * `false` if explicitly missing, `undefined` if unknown.
   *
   * Equivalent to Python `ModelConfig.has_credentials()`.
   */
  hasCredentials(providerName: string): boolean | undefined {
    const apiKeyEnv = ModelConfig.getApiKeyEnv(providerName);
    if (apiKeyEnv) {
      const val = resolveEnvVar(apiKeyEnv);
      if (val) return true;
      // Check if the env var exists (even as empty)
      if (apiKeyEnv in process.env) return false;
    }
    return undefined;
  },

  /**
   * Get model constructor kwargs from config.toml `[models.providers.X.params]`.
   *
   * Flat keys = provider-wide defaults; model-keyed sub-tables = per-model
   * overrides (shallow merge, model wins).
   *
   * Equivalent to Python `ModelConfig.get_kwargs()`.
   */
  getKwargs(providerName: string, modelName?: string): Record<string, unknown> {
    const config = ModelConfig.load();
    const provider = config.providers[providerName];
    if (!provider?.params) return {};

    const result: Record<string, unknown> = {};

    // Flat keys = provider-wide defaults (exclude sub-tables)
    for (const [key, value] of Object.entries(provider.params)) {
      if (typeof value !== "object" || value === null) {
        result[key] = value;
      }
    }

    // Model-level overrides (shallow merge)
    if (modelName) {
      const overrides = provider.params[modelName];
      if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
        Object.assign(result, overrides);
      }
    }

    return result;
  },

  /**
   * Get profile overrides from config.toml `[models.providers.X.profile]`.
   *
   * Same pattern as `getKwargs`: flat keys + model-level overrides.
   *
   * Equivalent to Python `ModelConfig.get_profile_overrides()`.
   */
  getProfileOverrides(providerName: string, modelName?: string): Record<string, unknown> {
    const config = ModelConfig.load();
    const provider = config.providers[providerName];
    if (!provider?.profile) return {};

    const result: Record<string, unknown> = {};

    // Flat keys (exclude sub-tables)
    for (const [key, value] of Object.entries(provider.profile)) {
      if (typeof value !== "object" || value === null) {
        result[key] = value;
      }
    }

    // Model-level overrides
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
// Config file writers — atomic read-modify-write with temp file + rename.
// Equivalent to Python `_save_toml_field()` / `save_default_model()`.
// =============================================================================

/**
 * Atomically write a `[section].field = value` entry in config.toml.
 *
 * Uses temp-file + rename pattern to prevent corruption on interrupt.
 * To serialize TOML we use a minimal approach: read the existing file,
 * parse, mutate, and write back with manual TOML formatting (section headers
 * plus key = value lines). This preserves user comments and formatting better
 * than round-tripping through a TOML serializer.
 *
 * @returns `true` on success, `false` on I/O or parse failure.
 */
function _saveTomlField(
  section: string,
  field: string,
  value: string,
  configPath: string = DEFAULT_CONFIG_PATH,
): boolean {
  try {
    mkdirSync(dirname(configPath), { recursive: true });

    // Read existing content
    let lines: string[] = [];
    if (existsSync(configPath)) {
      lines = readFileSync(configPath, "utf-8").split("\n");
    }

    // Find or create the section and field
    const sectionHeader = `[${section}]`;
    let sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);
    let fieldIdx = -1;
    let inSection = false;

    if (sectionIdx >= 0) {
      // Section exists — find the field within it
      for (let i = sectionIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        // Stop at next section or EOF
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
        if (trimmed.startsWith(`${field} =`)) {
          fieldIdx = i;
          break;
        }
      }
    }

    if (fieldIdx >= 0) {
      // Update existing field
      lines[fieldIdx] = `${field} = "${value}"`;
    } else {
      // Append field (and section if needed)
      if (sectionIdx < 0) {
        // Section doesn't exist — add it
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(sectionHeader);
        sectionIdx = lines.length - 1;
      }
      // Insert after section header (or after last non-empty line in section)
      let insertIdx = sectionIdx + 1;
      while (insertIdx < lines.length && lines[insertIdx].trim() !== "" && !lines[insertIdx].trim().startsWith("[")) {
        insertIdx++;
      }
      lines.splice(insertIdx, 0, `${field} = "${value}"`);
    }

    const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

    // Atomic write: temp file → rename
    const tmpPath = join(dirname(configPath), `.${basename(configPath)}.tmp.${Date.now()}`);
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, configPath);

    // Invalidate cache
    _configCache = null;
    return true;
  } catch (err) {
    logger.error(`Could not save ${section}.${field} preference: ${String(err)}`);
    return false;
  }
}

/**
 * Save the default model preference to config.toml `[models].default`.
 *
 * Equivalent to Python `save_default_model()`.
 */
export function saveDefaultModel(modelSpec: string, configPath?: string): boolean {
  return _saveTomlField("models", "default", modelSpec, configPath);
}

/**
 * Save the recent model preference to config.toml `[models].recent`.
 *
 * Equivalent to Python `save_recent_model()`.
 */
export function saveRecentModel(modelSpec: string, configPath?: string): boolean {
  return _saveTomlField("models", "recent", modelSpec, configPath);
}

/**
 * Remove the default model from config.toml.
 *
 * Equivalent to Python `clear_default_model()`.
 */
export function clearDefaultModel(configPath?: string): boolean {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  try {
    if (!existsSync(path)) return false;

    const lines = readFileSync(path, "utf-8").split("\n");
    const sectionHeader = "[models]";
    const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);
    if (sectionIdx < 0) return false;

    // Find and remove the "default = ..." line
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
      if (trimmed.startsWith("default =")) {
        lines.splice(i, 1);
        break;
      }
    }

    const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    const tmpPath = join(dirname(path), `.${basename(path)}.tmp.${Date.now()}`);
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, path);

    _configCache = null;
    return true;
  } catch (err) {
    logger.error(`Could not clear default model preference: ${String(err)}`);
    return false;
  }
}

// =============================================================================
// Cache management — equivalent to Python `clear_caches()`.
// =============================================================================

/**
 * Clear all module-level caches.
 *
 * Equivalent to Python `cortex.model_config.clear_caches()`.
 */
export function clearCaches(): void {
  _configCache = null;
}
