/**
 * Agent public surface — re-exports the split agent modules.
 *
 * agent/graph.ts was split into:
 *   - access-mode.ts  — legacy AccessMode leaf (cycle break)
 *   - presets.ts      — builtin AgentPreset catalog
 *   - subagent-defs.ts — builtin subagent data (Explore, general-purpose)
 *   - subagents.ts    — subagent FS scanner
 *   - model.ts        — buildChatModel / generateTitle
 *   - graph.ts        — graph compilation + cache + makeGraph
 */

export { createAgent, makeGraph, getCheckpointer, setCheckpointer, clearGraphCache } from "./graph.js";
export type { AgentGraph, CompiledAgent, SubagentRegistryEntry, ExternalSubagentSpec } from "./graph.js";
export { buildChatModel, generateTitle, TITLE_MAX_LENGTH } from "./model.js";
