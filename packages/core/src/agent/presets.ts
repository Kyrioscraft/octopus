/**
 * Builtin primary agents — the agent-based successor to AccessMode.
 *
 * Phase 1 of the agent migration (see architecture/AGENT_MIGRATION_PLAN.md): the four
 * access modes (plan/confirm/auto/full) become data-driven agent presets.
 * Each preset bundles the three things a "mode" used to drive in code:
 *   - promptBlock  : mode guidance injected by DynamicContextMiddleware
 *   - toolFilter   : static toolset filtering (plan strips destructive tools)
 *   - interruptOn  : runtime HITL override (auto/full suppress all gates)
 *
 * The values are lifted verbatim from the previous switch/if sites in
 * config.ts / agent.ts / dynamic_context_middleware.ts, so behavior is
 * unchanged — this is a pure refactor. Phase 2 replaces the coarse
 * tool-name booleans with a pattern-based permission Ruleset.
 */

import {
  evaluate,
  rulesetFromConfig,
  staticallyDisabledTools,
} from "../safety/permission/index.js";

// =============================================================================
// DESTRUCTIVE_TOOLS — relocated from the deleted agent/access-mode.ts (the
// access-mode mechanism is fully retired; this tool list remains a live
// dependency of the plan preset).
// =============================================================================

/**
 * Tool names with side effects — file writes, subagent/task delegation, and
 * conversation compaction. The plan agent strips these from the toolset so
 * it can only research/plan, not modify anything.
 *
 * NOTE: `execute` (shell) is deliberately NOT in this set — plan needs Bash
 * for codebase search; shell file writes are blocked separately by
 * FileEditGuardMiddleware + the shell_file_write permission rule.
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
  "task",
  "start_async_task",
  "update_async_task",
  "cancel_async_task",
  "compact_conversation",
]);
import type { PermissionConfig, Ruleset } from "../safety/permission/types.js";

// =============================================================================
// AgentPreset
// =============================================================================

/** A primary agent definition. Mirrors opencode's agent concept (mode:
 *  "primary"), specialized to what octopus's makeGraph consumes. */
export interface AgentPreset {
  /** Stable identifier — also the wire value (`agent` field) and DB value. */
  name: string;
  /** Short UI label (Chinese, matching the existing constants). */
  label: string;
  /** One-line UI description. */
  description: string;
  /** primary agents are user-switchable; subagents only run via `task`. */
  mode: "primary" | "subagent";
  /** Tool names removed from the toolset at build time (LLM never sees them).
   *  Kept literal (not derived from permissionConfig): `task` needs the
   *  nuance that plan strips any pre-SDK task tool defensively while still
   *  auto-approving the SDK-injected task tool at runtime. */
  disabledTools: Set<string>;
  /**
   * Runtime `interruptOn` override — tool names to auto-approve for the
   * whole run. `null` keeps the compiled HITL default (per-tool approval).
   * Derived from permissionConfig at module init (single source of truth).
   */
  interruptOnOverride: Record<string, boolean> | null;
  /** Whether FileEditGuard (shell file-write interception) is bypassed. */
  bypassFileEditGuard: boolean;
  /** Whether the submit_plan approval-gate tool is injected. */
  submitPlan: boolean;
  /**
   * Pattern-based permission rules (phase 2). Compiled from the
   * `permissionConfig` below — kept separate so the readable config shape
   * stays the single source of truth. The coarse fields above
   * (disabledTools / interruptOnOverride / bypassFileEditGuard) are derived
   * FROM these rules in phase 2+; they remain as the executable form.
   */
  permissionConfig: PermissionConfig;
  /** Compiled permission ruleset (flattened from permissionConfig). */
  permission: Ruleset;
  /** Mode guidance text injected into the dynamic context reminder. */
  promptBlock: string;
}

// =============================================================================
// Builtin presets
// =============================================================================

/**
 * plan — read-only research + approval gate (ZCode plan mode / opencode plan
 * agent). Destructive tools are stripped; read-only-but-gated tools
 * (task/execute/web_search/fetch_url) auto-approve; the agent must submit
 * its plan via `submit_plan` before any execution can happen.
 */
const plan: AgentPreset = {
  name: "plan",
  label: "计划模式",
  description: "只读探索免审批，计划需批准后执行",
  mode: "primary",
  disabledTools: new Set(DESTRUCTIVE_TOOLS),
  interruptOnOverride: Object.fromEntries(
    ["task", "execute", "web_search", "fetch_url"].map((n) => [n, false]),
  ),
  bypassFileEditGuard: false,
  submitPlan: true,
  // Declarative mirror of the executable fields above (order = priority):
  // destructive tools statically denied; read-only-but-gated tools allowed.
  permissionConfig: {
    write_file: "deny",
    edit_file: "deny",
    start_async_task: "deny",
    update_async_task: "deny",
    cancel_async_task: "deny",
    compact_conversation: "deny",
    task: "allow",
    execute: "allow",
    web_search: "allow",
    fetch_url: "allow",
    submit_plan: "allow",
    // Shell file-write commands (sed -i, echo >, tee, ...): hard-blocked by
    // FileEditGuardMiddleware (redirect to edit_file/write_file). Set to
    // "ask" to instead surface them as HITL approvals, or "allow" to pass.
    shell_file_write: "deny",
  },
  permission: rulesetFromConfig({
    write_file: "deny",
    edit_file: "deny",
    start_async_task: "deny",
    update_async_task: "deny",
    cancel_async_task: "deny",
    compact_conversation: "deny",
    task: "allow",
    execute: "allow",
    web_search: "allow",
    fetch_url: "allow",
    submit_plan: "allow",
    shell_file_write: "deny",
  }),
  promptBlock:
    "You are in PLAN mode. Do NOT execute write/edit/destructive tools. " +
    "Read-only operations (search via execute rg/find, subagent " +
    "delegation via task, web_search, fetch_url) run freely without " +
    "approval — use them liberally to explore. When you need the user to " +
    "choose between approaches or resolve an ambiguity, call " +
    "ask_user_question. Once your research is complete and the plan is " +
    "final, you MUST call submit_plan with the complete plan — it is the " +
    "ONLY way to exit plan mode and begin execution. Do not write the " +
    "plan as plain text; a plain-text plan will not pause for approval.",
};

/**
 * Read-only shell command allowlist (ZCode default-mode semantics: read-only
 * Bash runs freely, everything else asks). Shared by confirm and auto.
 * NOTE rule order: findLast evaluation means LATER rules override earlier
 * ones, so the `*: ask` catch-all goes FIRST and the specific allow rules
 * after it (mirroring opencode's `{ "*": "deny", "plans/*.md": "allow" }`
 * style — catch-all first, exceptions last).
 */
const READONLY_EXECUTE: Record<string, "allow" | "ask"> = {
  "*": "ask", // everything else asks (catch-all — must be FIRST)
  // search / list
  "rg *": "allow",
  "grep *": "allow",
  "find *": "allow",
  "ls*": "allow",
  "dir*": "allow",
  "pwd*": "allow",
  // read-only file peeking
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "wc *": "allow",
  "file *": "allow",
  // read-only git
  "git status*": "allow",
  "git diff*": "allow",
  "git log*": "allow",
  "git show*": "allow",
  "git branch*": "allow",
};

/**
 * confirm — the default execution agent (ZCode default / opencode "build"):
 * read-only Bash runs freely, other commands and file edits ask per-call.
 * Also carries submit_plan so an approved plan's pending interrupt can
 * resolve on the confirm-compiled graph.
 */
const confirm: AgentPreset = {
  name: "confirm",
  label: "变更确认",
  description: "每步变更都请你确认",
  mode: "primary",
  disabledTools: new Set(),
  interruptOnOverride: null,
  bypassFileEditGuard: false,
  submitPlan: true,
  permissionConfig: {
    "*": "ask",
    execute: READONLY_EXECUTE,
    shell_file_write: "ask",
  },
  permission: rulesetFromConfig({
    "*": "ask",
    execute: READONLY_EXECUTE,
    shell_file_write: "ask",
  }),
  promptBlock:
    "You are in CONFIRM mode. Tools that modify state require user " +
    "approval before execution. Read-only shell commands (search, listing, " +
    "git inspection) run freely.",
};

/**
 * auto — ZCode accept-edits semantics: file EDIT tools auto-approve, but
 * shell commands still ask per-call (only the read-only allowlist passes);
 * shell file-write commands ask instead of being hard-blocked.
 */
const auto: AgentPreset = {
  name: "auto",
  label: "自动编辑",
  description: "文件编辑自动执行，命令仍需确认",
  mode: "primary",
  disabledTools: new Set(),
  interruptOnOverride: Object.fromEntries(
    [...DESTRUCTIVE_TOOLS, "web_search", "fetch_url"].map((n) => [n, false]),
  ),
  bypassFileEditGuard: false,
  submitPlan: false,
  permissionConfig: {
    "*": "allow", // write_file/edit_file/task/... auto-approve (accept-edits)
    execute: READONLY_EXECUTE, // ...but Bash still asks (except allowlist)
    shell_file_write: "ask",
  },
  permission: rulesetFromConfig({
    "*": "allow",
    execute: READONLY_EXECUTE,
    shell_file_write: "ask",
  }),
  promptBlock:
    "You are in AUTO mode. File edits (write_file, edit_file) and task " +
    "delegation run without approval. Shell commands require user approval " +
    "except read-only ones (search, listing, git inspection).",
};

/** full — fully autonomous, FileEditGuard bypassed (shell writes allowed). */
const full: AgentPreset = {
  name: "full",
  label: "完全控制",
  description: "完全自主，无任何拦截",
  mode: "primary",
  disabledTools: new Set(),
  interruptOnOverride: Object.fromEntries(
    [...DESTRUCTIVE_TOOLS, "execute", "web_search", "fetch_url"].map((n) => [n, false]),
  ),
  bypassFileEditGuard: true,
  submitPlan: false,
  permissionConfig: { "*": "allow" },
  permission: rulesetFromConfig({ "*": "allow" }),
  promptBlock:
    "You are in FULL autonomous mode. The user has opted into fully " +
    "unattended operation — destructive tools run without approval. " +
    "Proceed directly; do not pause for confirmation.",
};

/** All builtin primary agents, keyed by name. Order = UI cycle order. */
export const BUILTIN_AGENTS: Record<string, AgentPreset> = {
  plan,
  confirm,
  auto,
  full,
};

/** The tools `_addInterruptOn()` gates — shared by config.ts's bridge.
 *  `task` is NOT gated: subagent delegation auto-approves (subagents run
 *  with empty interruptOn — see assembly.ts). */
export const GATED_TOOLS: string[] = [
  "execute",
  "write_file",
  "edit_file",
  "web_search",
  "fetch_url",
  "start_async_task",
  "update_async_task",
  "cancel_async_task",
  "compact_conversation",
];

// Derive each preset's runtime interruptOnOverride from its permission
// rules — the declarative config is the single source of truth. (Done as a
// post-pass rather than inline so the preset literals above stay readable.)
for (const preset of Object.values(BUILTIN_AGENTS)) {
  preset.interruptOnOverride = interruptOnForRuleset(preset.permission, GATED_TOOLS);
}

/** Cycle order for the Shift+Tab shortcut (mirrors MODE_ORDER). */
export const AGENT_ORDER: string[] = ["plan", "confirm", "auto", "full"];

export const DEFAULT_AGENT = "confirm";

/**
 * Resolve an agent name to a preset. Unknown/missing names (including
 * legacy `mode` values from old clients) fall back to `confirm`, matching
 * the previous server-side coercion. Legacy mode values are structurally compatible
 * with agent names in phase 1 — every legacy mode IS a builtin agent.
 */
export function resolveAgentPreset(name: string | undefined): AgentPreset {
  if (name && BUILTIN_AGENTS[name]) return BUILTIN_AGENTS[name];
  return BUILTIN_AGENTS[DEFAULT_AGENT];
}

/**
 * Derive the runtime `interruptOn` override from permission rules: for each
 * compiled HITL-gated tool, evaluate its ruleset verdict — "allow" (pattern
 * "*") auto-approves it for the whole run; "ask"/"deny" keep the compiled
 * default (deny-pattern-* tools are additionally stripped from the toolset
 * at build time — see staticallyDisabledTools).
 *
 * This is the phase-2 bridge between the pattern-based rules and langchain's
 * coarse per-tool interruptOn map. Returns null when nothing is auto-approved
 * (keep the compiled default), mirroring the old interruptOnForMode(null).
 *
 * @param gatedTools the tool names the compiled graph gates via
 *        `_addInterruptOn()` — the only ones an override can affect.
 */
export function interruptOnForRuleset(
  ruleset: Ruleset,
  gatedTools: string[],
): Record<string, boolean> | null {
  const override: Record<string, boolean> = {};
  let any = false;
  for (const tool of gatedTools) {
    const decision = evaluate(tool, "*", ruleset);
    if (decision.action === "allow") {
      override[tool] = false;
      any = true;
    }
  }
  return any ? override : null;
}
