/**
 * Settings — environment-based configuration.
 *
 * Equivalent to Python `cortex.config.Settings` (core env vars + API keys).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEnvVar, ModelConfig } from "./model_config.js";
import { DEFAULT_CONFIG_DIR } from "./constants.js";

// =============================================================================
// Types
// =============================================================================

export interface Settings {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  nvidiaApiKey?: string;
  tavilyApiKey?: string;

  googleCloudProject?: string;
  langsmithProject?: string;

  /**
   * LangSmith tracing 配置(独立于 sandbox,避免命名冲突)。
   *
   * 注意:`LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` 已被 deepagents
   * Sandbox(托管代码执行 VM)复用。这里通过 `OCTOPUS_LANGSMITH_TRACING_*`
   * 提供独立命名空间,落回通用 `LANGSMITH_*` 仅作为零代码路径的兼容。
   */
  langsmithTracingEnabled?: boolean;
  langsmithTracingApiKey?: string;
  langsmithTracingEndpoint?: string;
  langsmithTracingProject?: string;

  /** The resolved model name (provider:model). */
  modelName?: string;
  /** The resolved provider portion of modelName. */
  modelProvider?: string;

  /** Max input tokens from the model profile (from config.toml). */
  modelContextLimit?: number | null;
  /** Input modalities not supported by this model (from config.toml). */
  modelUnsupportedModalities: ReadonlySet<string>;

  /** Absolute path to the project root. */
  projectRoot?: string;

  /** Shell command allow-list patterns. */
  shellAllowList: string[];
  /** Extra directories for skill path containment. */
  extraSkillsDirs: string[];

  // -- Convenience accessors --
  readonly hasOpenai: boolean;
  readonly hasAnthropic: boolean;
  readonly hasGoogle: boolean;
  readonly hasNvidia: boolean;
  readonly hasTavily: boolean;
}

// =============================================================================
// .env loading — equivalent to Python `config._load_dotenv()`.
// =============================================================================

/**
 * Load variables from a .env file into process.env (only for keys not already set).
 *
 * This matches the Python behavior: project .env loads first, then
 * ~/.deepagents/.env, both with `override=False` (shell-exported vars win).
 */
function _loadDotEnvFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;

      let key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Only set if not already in environment (override=false behavior)
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // File missing or unreadable — silently skip
  }
}

/**
 * Load .env files in the standard order:
 * 1. Project/CWD `.env`
 * 2. `~/.deepagents/.env`
 *
 * Effective precedence: shell env > project .env > global .env
 *
 * Equivalent to Python `cortex.config._load_dotenv()`.
 */
export function loadDotEnv(): void {
  // 1. Project .env
  _loadDotEnvFile(join(process.cwd(), ".env"));

  // 2. Global ~/.deepagents/.env
  _loadDotEnvFile(join(DEFAULT_CONFIG_DIR, ".env"));
}

// =============================================================================
// fromEnvironment — build Settings from env vars.
// =============================================================================

/**
 * Build a Settings object from environment variables.
 *
 * All API keys are resolved through `resolveEnvVar` so the
 * `DEEPAGENTS_CODE_` prefix override is honored.
 *
 * Equivalent to Python `Settings.from_environment()`.
 */
export function fromEnvironment(): Settings {
  const openaiApiKey = resolveEnvVar("OPENAI_API_KEY") ?? undefined;
  const anthropicApiKey = resolveEnvVar("ANTHROPIC_API_KEY") ?? undefined;
  const googleApiKey = resolveEnvVar("GOOGLE_API_KEY") ?? undefined;
  const nvidiaApiKey = resolveEnvVar("NVIDIA_API_KEY") ?? undefined;
  const tavilyApiKey = resolveEnvVar("TAVILY_API_KEY") ?? undefined;

  const googleCloudProject = process.env["GOOGLE_CLOUD_PROJECT"] || undefined;
  const langsmithProject = process.env["DEEPAGENTS_CODE_LANGSMITH_PROJECT"]
    ?? process.env["LANGSMITH_PROJECT"]
    ?? undefined;

  // LangSmith tracing —— 独立命名空间,避免与 sandbox 复用的 LANGSMITH_* 冲突。
  // 优先用 OCTOPUS_LANGSMITH_TRACING_*,落回通用 LANGSMITH_* 兼容零代码路径。
  const langsmithTracingRaw = resolveEnvVar("OCTOPUS_LANGSMITH_TRACING");
  const langsmithTracingEnabled =
    langsmithTracingRaw === "true" || langsmithTracingRaw === "1";
  const langsmithTracingApiKey =
    resolveEnvVar("OCTOPUS_LANGSMITH_TRACING_API_KEY")
    ?? resolveEnvVar("LANGSMITH_API_KEY")
    ?? undefined;
  const langsmithTracingEndpoint =
    resolveEnvVar("OCTOPUS_LANGSMITH_TRACING_ENDPOINT")
    ?? resolveEnvVar("LANGSMITH_ENDPOINT")
    ?? undefined;
  const langsmithTracingProject =
    resolveEnvVar("OCTOPUS_LANGSMITH_TRACING_PROJECT")
    ?? resolveEnvVar("LANGSMITH_PROJECT")
    ?? "octopus";

  const projectRoot = process.env["DEEPAGENTS_CODE_SERVER_CWD"]
    ?? process.env["DEEPAGENTS_CODE_PROJECT_ROOT"]
    ?? process.cwd();

  // Shell allow-list: comma-separated list from env
  const shellAllowListRaw = process.env["DEEPAGENTS_CODE_SHELL_ALLOW_LIST"] || "";
  const shellAllowList = shellAllowListRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Extra skills dirs: comma-separated list from env or config.toml [skills]
  const extraSkillsDirsRaw = process.env["DEEPAGENTS_CODE_EXTRA_SKILLS_DIRS"] || "";
  const extraSkillsDirs = extraSkillsDirsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Model profile: context limit and unsupported modalities from config.toml
  let modelContextLimit: number | null = null;
  let modelUnsupportedModalities: ReadonlySet<string> = new Set();
  try {
    const config = ModelConfig.load();
    // Try to extract profile overrides for known providers
    // The providers key gives us provider-level profile overrides
    const providers = config.providers;
    for (const [, providerCfg] of Object.entries(providers)) {
      if (providerCfg.profile) {
        // Check for flat context_limit / unsupported_modalities
        const profile = providerCfg.profile as Record<string, unknown>;
        if (typeof profile["context_limit"] === "number") {
          modelContextLimit = profile["context_limit"] as number;
        }
        if (typeof profile["unsupported_modalities"] === "string") {
          modelUnsupportedModalities = new Set(
            (profile["unsupported_modalities"] as string)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    }
  } catch {
    // Config parse failure — profile unavailable, leave defaults
  }

  return {
    openaiApiKey,
    anthropicApiKey,
    googleApiKey,
    nvidiaApiKey,
    tavilyApiKey,
    googleCloudProject,
    langsmithProject,
    langsmithTracingEnabled,
    langsmithTracingApiKey,
    langsmithTracingEndpoint,
    langsmithTracingProject,
    projectRoot,
    shellAllowList,
    extraSkillsDirs,
    modelContextLimit,
    modelUnsupportedModalities,

    // Convenience accessors
    get hasOpenai() { return this.openaiApiKey !== undefined; },
    get hasAnthropic() { return this.anthropicApiKey !== undefined; },
    get hasGoogle() { return this.googleApiKey !== undefined; },
    get hasNvidia() { return this.nvidiaApiKey !== undefined; },
    get hasTavily() { return this.tavilyApiKey !== undefined; },
  };
}

// =============================================================================
// reloadFromEnvironment — hot-reload API keys and paths.
// =============================================================================

/**
 * Re-load only the reloadable fields (API keys, project root, shell allow-list,
 * skills dirs, langsmith project). Preserves model state.
 *
 * Returns a list of change descriptions for logging/UI feedback.
 *
 * Equivalent to Python `Settings.reload_from_environment()`.
 */
export function reloadFromEnvironment(prev: Settings): { settings: Settings; changes: string[] } {
  const next = fromEnvironment();
  const changes: string[] = [];

  const reloadableKeys: (keyof Settings)[] = [
    "openaiApiKey", "anthropicApiKey", "googleApiKey", "nvidiaApiKey",
    "tavilyApiKey", "googleCloudProject", "langsmithProject",
    "langsmithTracingEnabled", "langsmithTracingApiKey",
    "langsmithTracingEndpoint", "langsmithTracingProject",
    "projectRoot", "shellAllowList", "extraSkillsDirs",
  ];

  for (const key of reloadableKeys) {
    const oldVal = prev[key];
    const newVal = next[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push(`${key}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
    }
  }

  // Preserve model state fields from prev
  next.modelName = prev.modelName;
  next.modelProvider = prev.modelProvider;

  return { settings: next, changes };
}
