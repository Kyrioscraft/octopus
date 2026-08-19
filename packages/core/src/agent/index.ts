/**
 * Agent public surface — re-exports the split agent modules.
 *
 *   - graph.ts        — makeGraph entry + compilation pipeline
 *   - kernel.ts       — checkpointer singleton + graph cache
 *   - model.ts        — buildChatModel / generateTitle
 *   - backend.ts      — BashShellBackend / CompositeBackend construction
 *   - hitl.ts         — HITL interrupt configuration
 *   - assembly.ts     — subagent specs + registry assembly
 *   - presets.ts      — builtin AgentPreset catalog
 *   - subagent-defs.ts — builtin subagent data (Explore, general-purpose)
 *   - subagents.ts    — subagent FS scanner
 */

export { createAgent, makeGraph } from "./graph.js";
export type { AgentGraph, CompiledAgent, SubagentRegistryEntry, ExternalSubagentSpec } from "./graph.js";
export { getCheckpointer, setCheckpointer, clearGraphCache } from "./kernel.js";
export { buildChatModel, generateTitle, TITLE_MAX_LENGTH } from "./model.js";
export { DESTRUCTIVE_TOOLS } from "./presets.js";
