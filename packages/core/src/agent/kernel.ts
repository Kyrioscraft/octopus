/**
 * Agent kernel — checkpointer singleton + graph cache.
 *
 * The stable core of the agent runtime: everything else (model building,
 * tool resolution, middleware ordering, subagent/skill wiring) is assembled
 * around it by pipeline stages in graph.ts.
 *
 * The cache key is a structured array (JSON-serialized) rather than ad-hoc
 * string concatenation — every component is named, so adding a new axis is
 * a one-line change instead of fragile `+ ":" +` surgery.
 */

import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { CompiledAgent } from "./graph.js";

// =============================================================================
// Checkpointer — process-level singleton. Defaults to MemorySaver (state lost
// on restart); the server can inject a durable one (SQLite) via
// setCheckpointer() at startup so HITL interrupts survive restarts.
// =============================================================================

let _checkpointer: MemorySaver | unknown = null;

export function getCheckpointer(): unknown {
  if (!_checkpointer) {
    _checkpointer = new MemorySaver();
  }
  return _checkpointer;
}

/**
 * Replace the process-level checkpointer (e.g. with the SQLite checkpointer).
 * Must be called BEFORE any graph is built/used — existing compiled graphs
 * hold a reference to the previous instance, so this also clears the graph
 * cache to force recompilation against the new checkpointer.
 */
export function setCheckpointer(cp: unknown): void {
  _checkpointer = cp;
  clearGraphCache();
}

// =============================================================================
// Graph cache — keyed by every axis that changes the compiled graph shape.
// Equivalent to Python `agent_config_service._graph_cache`.
//
// Axes (all required — callers normalize before calling cacheKey):
//   model / systemPrompt / tools / enableShell / enableWebSearch /
//   mcpSignature / subagentSignature — the legacy base key; plus
//   workspace (local|sandbox), agent name, external tools, builtin subagent
//   model overrides, cwd.
// =============================================================================

const _graphCache = new Map<string, Promise<CompiledAgent>>();

export interface GraphCacheKey {
  model: string;
  systemPrompt: string;
  tools: string[];
  enableShell: boolean;
  enableWebSearch: boolean;
  mcpSignature: string;
  subagentSignature: string;
  workspace: string;
  agent: string;
  externalTools: string;
  builtinSubagentOverrides: string;
  cwd: string;
}

/** Serialize the cache key. JSON of a fixed-shape array — stable across runs. */
export function cacheKey(key: GraphCacheKey): string {
  return JSON.stringify([
    key.model,
    key.systemPrompt,
    [...key.tools].sort(),
    key.enableShell,
    key.enableWebSearch,
    key.mcpSignature,
    key.subagentSignature,
    key.workspace,
    key.agent,
    key.externalTools,
    key.builtinSubagentOverrides,
    key.cwd,
  ]);
}

export function getCachedGraph(key: string): Promise<CompiledAgent> | undefined {
  return _graphCache.get(key);
}

/**
 * Store a graph promise. Failed builds are removed from the cache when their
 * promise rejects so retries work.
 */
export function setCachedGraph(key: string, promise: Promise<CompiledAgent>): void {
  _graphCache.set(key, promise);
  promise.catch(() => {
    _graphCache.delete(key);
  });
}

export function clearGraphCache(): void {
  _graphCache.clear();
}
