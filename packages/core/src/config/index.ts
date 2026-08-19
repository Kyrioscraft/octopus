/**
 * ServerConfig — unified configuration for the agent engine.
 *
 * Equivalent to Python `cortex.server_config.ServerConfig`.
 *
 * Provides:
 *   - Zod schema with defaults (12 fields)
 *   - `loadConfig()` — resolve from env vars + config.toml
 *   - `fromDict()` / `toDict()` — for web_server compatibility
 */

import { z } from "zod";
import { ModelConfig } from "../providers/index.js";
import { clearCaches } from "../providers/index.js";
// Cycle break: AccessMode / DESTRUCTIVE_TOOLS live in the leaf module
// agent/access-mode.ts so config no longer owns them. Re-exported here for
// API compatibility; presets depend on the leaf, not on config.
import type { AccessMode } from "../agent/access-mode.js";
export { DESTRUCTIVE_TOOLS } from "../agent/access-mode.js";
export type { AccessMode } from "../agent/access-mode.js";
import { presetForAccessMode, interruptOnForRuleset, GATED_TOOLS } from "../agent/presets.js";

/**
 * Compute the runtime `interruptOn` override for a given access mode.
 *
 * The langchain `humanInTheLoopMiddleware` merges its compiled `interruptOn`
 * with `runtime.context` (the latter wins — see hitl.js config assembly), so
 * injecting `{ interruptOn: { <tool>: false } }` into the runtime context
 * auto-approves those tools for the whole run without recompiling the graph.
 *
 * @returns The override object, or `null` to keep the compiled default.
 */
export function interruptOnForMode(
  mode: AccessMode,
): Record<string, boolean> | null {
  // Phase 2 of the agent migration: derive the override from the preset's
  // pattern-based permission rules instead of hard-coded tool lists.
  // Behavior for the four builtin presets is identical to phase 1.
  return interruptOnForRuleset(presetForAccessMode(mode).permission, GATED_TOOLS);
}

// =============================================================================
// Schema
// =============================================================================

export const ServerConfigSchema = z.object({
  /** Model spec string e.g. "anthropic:claude-sonnet-4-6" or "openai:gpt-4o" */
  model: z.string().default("anthropic:claude-sonnet-4-6"),

  /** Model constructor params (e.g. temperature) */
  modelParams: z.record(z.string(), z.unknown()).default({}),

  /** Optional assistant ID for memory/completion tracking */
  assistantId: z.string().optional(),

  /** System prompt override */
  systemPrompt: z.string().optional(),

  /** Tool names to enable */
  tools: z.array(z.string()).default([]),

  /** MCP server names — sentinel list to open the MCP gate in makeGraph */
  mcpServers: z.array(z.string()).default([]),

  /** Enable interactive (HITL) mode */
  interactive: z.boolean().default(true),

  /** Auto-approve all tool calls without prompting */
  autoApprove: z.boolean().default(false),

  /** Enable shell execution tool */
  enableShell: z.boolean().default(false),

  /** Enable agent memory (filesystem-based) */
  enableMemory: z.boolean().default(false),

  /** Enable skills subsystem */
  enableSkills: z.boolean().default(false),

  /** Enable web search tool */
  enableWebSearch: z.boolean().default(true),

  /** Provider overrides — { providerId: { baseUrl?, apiKeyEnv? } } */
  providerOverrides: z.record(
    z.string(),
    z.object({
      baseUrl: z.string().optional(),
      apiKeyEnv: z.string().optional(),
    }),
  ).default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// =============================================================================
// loadConfig — resolve from env + config.toml.
// Equivalent to Python `ServerConfig.from_env()`.
// =============================================================================

/** The hardcoded default model (same as Python `ServerConfig`). */
const HARDCODED_DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";

/**
 * Build a `ServerConfig` from environment variables and `~/.deepagents/config.toml`.
 *
 * Model resolution precedence (matches Python `ServerConfig.from_env()`):
 * 1. `OCTOPUS_MODEL` env var (highest priority)
 * 2. `OCTOPUS_DEFAULT_MODEL` env var (from .env)
 * 3. `config.toml` `[models].default`
 * 4. Hardcoded default `"anthropic:claude-sonnet-4-6"`
 *
 * Equivalent to Python `cortex.server_config.ServerConfig.from_env()`.
 */
export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  // Force-reload config to avoid stale cache (the cache may have been
  // populated before config.json was written).
  clearCaches();

  // 1. OCTOPUS_MODEL (highest priority)
  const explicitModel = process.env["OCTOPUS_MODEL"];

  // 2. OCTOPUS_DEFAULT_MODEL (from .env)
  const defaultEnvModel = process.env["OCTOPUS_DEFAULT_MODEL"];

  // 3. config.toml [models].default
  const config = ModelConfig.load();
  const configDefault = config.default_model;

  // Build the effective model
  let model = explicitModel
    ?? defaultEnvModel
    ?? configDefault
    ?? HARDCODED_DEFAULT_MODEL;

  // If the result still equals the hardcoded default, try config.toml recent_model
  // (matches Python behavior where from_env falls back to config.toml default before hardcoded)
  if (model === HARDCODED_DEFAULT_MODEL && config.recent_model) {
    model = config.recent_model;
  }

  // Env-driven boolean flags (matching Python env vars)
  const interactive = process.env["OCTOPUS_INTERACTIVE"] !== "false";
  const autoApprove = process.env["OCTOPUS_AUTO_APPROVE"] === "true";
  const enableShell = process.env["OCTOPUS_ENABLE_SHELL"] !== "false";
  const enableWebSearch = process.env["OCTOPUS_ENABLE_WEB_SEARCH"] !== "false";

  return ServerConfigSchema.parse({
    model,
    interactive,
    autoApprove,
    enableShell,
    enableWebSearch,
    ...overrides,
  });
}

// =============================================================================
// fromDict / toDict — for web_server mode.
// Equivalent to Python `ServerConfig.from_dict()` / `ServerConfig.to_dict()`.
// =============================================================================

/**
 * Build a ServerConfig from a plain object (e.g. DB agent config JSON).
 *
 * Only matching keys are extracted; unknown keys are silently ignored.
 * Missing fields fall through to Zod schema defaults.
 *
 * Equivalent to Python `ServerConfig.from_dict()`.
 */
export function fromDict(data: Record<string, unknown>): ServerConfig {
  const filtered: Record<string, unknown> = {};

  const knownKeys = Object.keys(ServerConfigSchema.shape);
  for (const key of knownKeys) {
    if (key in data) {
      filtered[key] = data[key];
    }
  }

  return ServerConfigSchema.parse(filtered);
}

/**
 * Export a ServerConfig to a plain object (for DB storage / serialization).
 *
 * Equivalent to Python `ServerConfig.to_dict()`.
 */
export function toDict(config: ServerConfig): Record<string, unknown> {
  return { ...config };
}
