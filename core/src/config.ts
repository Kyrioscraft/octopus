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
import { ModelConfig } from "./model_config.js";
import { clearCaches } from "./model_config.js";

// =============================================================================
// Access modes — workspace access mode (plan / confirm / auto / full).
//
// Drives two orthogonal behaviors at graph-build and runtime:
//   - plan   : destructive tools are removed from the toolset (read-only).
//   - confirm: per-tool HITL interrupts apply (the compiled default).
//   - auto   : all HITL interrupts are suppressed at runtime via context.
//   - full   : like auto (HITL suppressed) AND the FileEditGuard content
//              guard is bypassed at build time — shell commands that write
//              files are no longer hard-blocked. The agent runs fully
//              autonomously and is responsible for its own actions.
// The front-end sends `mode` per request; the server resolves it to one of
// these and threads it into makeGraph (tool filtering + FileEditGuard bypass)
// and the runtime context (HITL override). Defined here (not in tentacle) to
// keep architecture boundaries: server → core only.
// =============================================================================

export type AccessMode = "plan" | "confirm" | "auto" | "full";

/**
 * Tool names with side effects — file writes, shell execution, subagent/task
 * delegation, and conversation compaction. In `plan` mode these are stripped
 * from the toolset so the agent can only read/search, not modify anything.
 *
 * Read-only tools (read_file, ls, glob, grep, web_search, fetch_url) are
 * intentionally excluded — they are safe in every mode.
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
  "execute",
  "task",
  "start_async_task",
  "update_async_task",
  "cancel_async_task",
  "compact_conversation",
]);

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
  if (mode === "auto" || mode === "full") {
    // Suppress every gated tool (destructive + the read-only-but-gated
    // web_search/fetch_url) so the run is fully autonomous. `auto` and
    // `full` share the same HITL override; they differ only in that `full`
    // additionally bypasses FileEditGuard at build time (see agent.ts).
    const all = [...DESTRUCTIVE_TOOLS, "web_search", "fetch_url"];
    return Object.fromEntries(all.map((n) => [n, false]));
  }
  // plan: destructive tools are already absent from the toolset, so there is
  //   nothing to interrupt — no override needed.
  // confirm: the compiled `_addInterruptOn()` already gates every destructive
  //   tool — keep the default.
  return null;
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
