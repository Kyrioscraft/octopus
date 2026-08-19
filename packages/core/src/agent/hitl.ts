/**
 * HITL (human-in-the-loop) interrupt configuration.
 *
 * Owns:
 *   - `buildInterruptOn` — the compiled-graph interrupt map (equivalent to
 *     Python `_add_interrupt_on()`), driven by the preset's permission rules.
 *   - `interruptOnForMode` — the runtime `runtime.context` override (moved
 *     here from config/index.ts; it is a runtime concern, not config).
 */

import type { AccessMode } from "./access-mode.js";
import { presetForAccessMode } from "./presets.js";
import { GATED_TOOLS, interruptOnForRuleset } from "./presets.js";
import type { Ruleset } from "../safety/permission/types.js";
import { evaluate } from "../safety/permission/index.js";
import { shouldInterruptExecute, detectFileWrite } from "../middleware/file_edit_guard.js";

/** Whether compact_conversation requires HITL approval. */
const REQUIRE_COMPACT_TOOL_APPROVAL = true;

/**
 * Build the full HITL interrupt configuration mapping tool names to their
 * interrupt settings. Every tool that can have side effects or access
 * external resources is gated behind an approval prompt.
 *
 * Equivalent to Python `_add_interrupt_on()`.
 *
 * @param fileWriteRuleset the preset's permission rules, used by the
 *        `execute` entry's `when` predicate: ordinary commands follow the
 *        `execute` rule verdict; detected file-write commands additionally
 *        follow `shell_file_write` (see shouldInterruptExecute — pairs with
 *        FileEditGuardMiddleware, which hard-blocks "deny").
 */
export function buildInterruptOn(fileWriteRuleset?: Ruleset): Record<string, any> {
  const interruptMap: Record<string, any> = {
    execute: {
      allowedDecisions: ["approve", "reject"],
      // Dynamic description (langchain HITL calls description(toolCall, state,
      // runtime)) — surfaces WHY this command asks: the matched permission
      // rule for execute / shell_file_write, so the approval UI can show
      // "triggered by rule X" instead of a generic message.
      ...(fileWriteRuleset
        ? {
            description: (toolCall: { args?: Record<string, unknown> }) => {
              const command = String(toolCall?.args?.["command"] ?? "");
              const isFileWrite = !!detectFileWrite(command);
              const permission = isFileWrite ? "shell_file_write" : "execute";
              const decision = evaluate(permission, command, fileWriteRuleset);
              if (decision.rule) {
                return (
                  `Allow shell command execution? (matched permission rule ` +
                  `"${decision.rule.permission}: ${decision.rule.pattern}" → ${decision.rule.action})`
                );
              }
              return "Allow shell command execution? (no matching rule — default ask)";
            },
            when: (request: {
              toolCall: { name: string; args?: Record<string, unknown> };
            }) =>
              shouldInterruptExecute(
                String((request.toolCall.args as Record<string, unknown>)?.["command"] ?? ""),
                fileWriteRuleset,
              ),
          }
        : { description: "Allow shell command execution?" }),
    },
    write_file: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow file write?",
    },
    edit_file: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow file edit?",
    },
    web_search: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow web search?",
    },
    fetch_url: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow URL fetch?",
    },
    task: {
      allowedDecisions: ["approve", "reject"],
      description: "Allow task delegation to subagent?",
    },
    start_async_task: {
      allowedDecisions: ["approve", "reject"],
      description: "Launch, update, or cancel a remote async subagent.",
    },
    update_async_task: {
      allowedDecisions: ["approve", "reject"],
      description: "Launch, update, or cancel a remote async subagent.",
    },
    cancel_async_task: {
      allowedDecisions: ["approve", "reject"],
      description: "Launch, update, or cancel a remote async subagent.",
    },
  };

  if (REQUIRE_COMPACT_TOOL_APPROVAL) {
    interruptMap["compact_conversation"] = {
      allowedDecisions: ["approve", "reject"],
      description:
        "Offloads older messages to backend storage and " +
        "replaces them with a summary, freeing context " +
        "window space. Recent messages are kept as-is. " +
        "Full history remains available for retrieval.",
    };
  }

  return interruptMap;
}

/**
 * Compute the runtime `interruptOn` override for a given access mode.
 *
 * The langchain `humanInTheLoopMiddleware` merges its compiled `interruptOn`
 * with `runtime.context` (the latter wins — see hitl.js config assembly), so
 * injecting `{ interruptOn: { <tool>: false } }` into the runtime context
 * auto-approves those tools for the whole run without recompiling the graph.
 *
 * Moved here from config/index.ts — it derives from presets (agent domain),
 * and keeping it in config forced config to import agent modules (cycle).
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
