import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Paths — equivalent to Python `cortex.model_config`.
// =============================================================================

export const DEFAULT_CONFIG_DIR = join(homedir(), ".deepagents");
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.json");
export const DEFAULT_STATE_DIR = join(DEFAULT_CONFIG_DIR, ".state");

// =============================================================================
// Env var prefix override — equivalent to Python `_ENV_PREFIX`.
// =============================================================================

export const ENV_PREFIX = "DEEPAGENTS_CODE_";

// =============================================================================
// Provider API key registry — equivalent to Python `PROVIDER_API_KEY_ENV`.
// Maps well-known provider names to the canonical env var holding their key.
// =============================================================================

export const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ollama: "OLLAMA_API_KEY",
  xai: "XAI_API_KEY",
};

// =============================================================================
// Provider base URL registry — equivalent to Python `PROVIDER_BASE_URL_ENV`.
// Each tuple lists every base-URL env var the provider's SDK may read,
// canonical name first.
// =============================================================================

export const PROVIDER_BASE_URL_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_URL"],
  deepseek: ["DEEPSEEK_API_BASE"],
  openai: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
  openrouter: ["OPENROUTER_API_BASE"],
  xai: ["XAI_API_BASE"],
};

// =============================================================================
// Auth classification — equivalent to Python constants.
// =============================================================================

/** Providers whose credentials are managed through implicit/platform auth. */
export const IMPLICIT_AUTH_PROVIDERS = new Set(["google_vertexai"]);

/** Providers that do not require an API key (e.g. local endpoints). */
export const NO_AUTH_REQUIRED_PROVIDERS = new Set(["ollama"]);

/** Providers with an optional API key env var. */
export const OPTIONAL_AUTH_ENV: Record<string, string> = {
  ollama: "OLLAMA_API_KEY",
};

// =============================================================================
// Agent defaults — equivalent to Python `_constants.DEFAULT_AGENT_NAME`.
// =============================================================================

export const DEFAULT_AGENT_ID = "ChatbotAgent";
