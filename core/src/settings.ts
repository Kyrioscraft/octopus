/**
 * Settings — environment-based configuration.
 *
 * Equivalent to Python `cortex.config.Settings` (core env vars + API keys only).
 * Omitted from the Python original (2541 lines total):
 *   - Model profile system (context_limit, unsupported_modalities)
 *   - Path methods (get_agent_dir, get_user_skills_dir, etc.)
 *   - Interpreter settings (enable_interpreter, timeout, memory, etc.)
 *   - Sandbox settings
 *   - create_model() / detect_provider() (moved to agent.ts)
 *   - Rich Console singleton
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEnvVar } from "./model_config.js";
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

  /** The resolved model name (provider:model). */
  modelName?: string;
  /** The resolved provider portion of modelName. */
  modelProvider?: string;

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

  return {
    openaiApiKey,
    anthropicApiKey,
    googleApiKey,
    nvidiaApiKey,
    tavilyApiKey,
    googleCloudProject,
    langsmithProject,
    projectRoot,
    shellAllowList,
    extraSkillsDirs,

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
