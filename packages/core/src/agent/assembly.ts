/**
 * Subagent assembly — extracted from agent/graph.ts.
 *
 * Owns the two subagent-related wiring steps of graph compilation:
 *   1. `assembleSubagentSpecs` — the createDeepAgent `subagents` array from
 *      external (server-injected) + built-in explicit subagents.
 *   2. `buildSubagentRegistry` — the runtime name→systemPrompt lookup map
 *      mirroring every subagent (including SDK-injected built-ins).
 *
 * Every subagent spec carries a `middleware` field with the
 * BinaryContentSanitizerMiddleware. The SDK merges it via
 * `...input.middleware ?? []`, but the main agent's middleware stack is NOT
 * inherited by subagents — without this, a subagent's `read_file` on a
 * binary file yields a `{type:"file"}` block that crashes the Rust
 * checkpointer on the next turn (400 deserialization error). Explore
 * (which exists to read files) is especially vulnerable.
 */

import { getLogger } from "../logging.js";
import { BinaryContentSanitizerMiddleware } from "../middleware/binary_content_sanitizer.js";
import { BUILTIN_SUBAGENTS } from "./subagent-defs.js";
import type { ExternalSubagentSpec, SubagentRegistryEntry } from "./graph.js";

const logger = getLogger("agent.subagents-assembly");

/**
 * Resolve a tool-name whitelist into StructuredTool instances from the main
 * agent's compiled toolset. Enables the SDK's `SubAgent.tools` capability.
 * Unknown tool names (e.g. an MCP tool that wasn't loaded) are skipped with
 * a warning rather than failing the build.
 */
function resolveToolWhitelist(names: string[] | undefined, tools: any[]): any[] | undefined {
  if (!names || names.length === 0) return undefined;
  const byName = new Map<string, any>();
  for (const t of tools) {
    if (t?.name) byName.set(t.name, t);
  }
  const resolved: any[] = [];
  for (const n of names) {
    const t = byName.get(n);
    if (t) {
      resolved.push(t);
    } else {
      logger.warn(
        `Subagent tool whitelist references unknown tool "${n}" — ` +
        `it is not in the main agent toolset and will be ignored. ` +
        `Available tools: ${[...byName.keys()].join(", ")}`,
      );
    }
  }
  return resolved.length > 0 ? resolved : undefined;
}

/**
 * Build the createDeepAgent `subagents` array. Two groups:
 *   - external subagents (file + user-defined): always injected explicitly.
 *   - built-in subagents with injectedBy === "explicit" (Explore): injected.
 * Built-ins with injectedBy === "sdk" (general-purpose) are auto-injected by
 * the SDK itself — including them here would create duplicates, so they are
 * skipped (but still mirrored into the registry by buildSubagentRegistry).
 */
export function assembleSubagentSpecs(
  externalSubagents: ExternalSubagentSpec[],
  mainTools: any[],
  builtinSubagentOverrides?: Record<string, string | null>,
): any[] {
  const subagentMiddleware = [new BinaryContentSanitizerMiddleware()];
  const subagentSpecs: any[] = [];
  for (const sa of externalSubagents) {
    const spec: Record<string, unknown> = {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      // Propagate the binary-content sanitizer — see module header.
      middleware: subagentMiddleware,
      // Subagent tool calls run WITHOUT HITL interrupts — approval happens
      // once, at the parent's `task` delegation gate. Without this the SDK
      // propagates the main graph's interruptOn to every subagent and each
      // subagent tool call re-prompts.
      interruptOn: {},
    };
    const whitelist = resolveToolWhitelist(sa.tools, mainTools);
    if (whitelist) spec.tools = whitelist;
    if (sa.model) spec.model = sa.model;
    subagentSpecs.push(spec);
  }
  for (const sa of BUILTIN_SUBAGENTS) {
    // general-purpose (injectedBy === "sdk") is ALSO injected explicitly here:
    // the SDK's auto-injected copy inherits defaultInterruptOn (HITL gates),
    // but subagent tool calls must not re-prompt. graph.ts disables the SDK's
    // auto-injection (generalPurposeAgent: false); this explicit spec — with
    // interruptOn: {} — shadows it cleanly. User-defined subagents that
    // shadow a built-in name already won the loop above.
    const spec: Record<string, unknown> = {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      middleware: subagentMiddleware,
      // See above — subagents inherit no HITL interrupts.
      interruptOn: {},
    };
    // Built-in explicit subagents force their own whitelist (Explore is
    // read-only by construction) — the value on the BuiltInSubagent wins.
    const whitelist = resolveToolWhitelist(sa.tools, mainTools);
    if (whitelist) spec.tools = whitelist;
    // Per-user model override (from the server's builtin override store)
    // wins over the BuiltInSubagent's default. Note: SDK-injected built-ins
    // (general-purpose) skip this loop entirely, so their overrides are
    // recorded but not applied yet.
    const override = builtinSubagentOverrides?.[sa.name];
    const model = override !== undefined ? override : sa.model;
    if (model) spec.model = model;
    subagentSpecs.push(spec);
  }
  return subagentSpecs;
}

/**
 * Build the runtime subagent registry (name → entry). Mirrors every
 * subagent — external (file/user-defined) AND built-in — so wrapAgentStream
 * can resolve the systemPrompt regardless of who injected the subagent.
 * Built-ins with injectedBy === "sdk" are NOT in subagentSpecs (the SDK
 * auto-injects them), but are still mirrored here. A user-provided
 * subagent intentionally shadowing a built-in name wins.
 */
export function buildSubagentRegistry(
  externalSubagents: ExternalSubagentSpec[],
): Map<string, SubagentRegistryEntry> {
  const registry = new Map<string, SubagentRegistryEntry>();
  for (const sa of externalSubagents) {
    registry.set(sa.name, {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      source: (sa.source === "file" ? "user" : "user-defined") as
        | "user"
        | "project"
        | "user-defined",
    });
  }
  for (const sa of BUILTIN_SUBAGENTS) {
    // Don't clobber a user-provided subagent that intentionally shadows a
    // built-in name (e.g. a custom "general-purpose").
    if (registry.has(sa.name)) continue;
    registry.set(sa.name, {
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      source: "builtin",
    });
  }
  return registry;
}
