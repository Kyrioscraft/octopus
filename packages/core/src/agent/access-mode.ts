/**
 * Access modes — legacy workspace access mode (plan / confirm / auto / full).
 *
 * Drives two orthogonal behaviors at graph-build and runtime:
 *   - plan   : destructive tools are removed from the toolset (read-only).
 *   - confirm: per-tool HITL interrupts apply (the compiled default).
 *   - auto   : all HITL interrupts are suppressed at runtime via context.
 *   - full   : like auto (HITL suppressed) AND the FileEditGuard content
 *              guard is bypassed at build time — shell commands that write
 *              files are no longer hard-blocked. The agent runs fully
 *              autonomously and is responsible for its own actions.
 * The front-end sends `mode` per request; the server resolves it to one of
 * these and threads it into makeGraph (tool filtering + FileEditGuard bypass)
 * and the runtime context (HITL override). Defined here (not in tentacle) to
 * keep architecture boundaries: server → core only.
 *
 * Phase 1 of the agent migration keeps AccessMode as an alias for the
 * same-named builtin agent presets (see agent/presets.ts). This module exists
 * so that `config/` no longer imports preset logic (breaking the old
 * config.ts ⇄ agents/builtin.ts cycle): presets and config both depend on
 * this leaf, in opposite directions.
 */

export type AccessMode = "plan" | "confirm" | "auto" | "full";

/**
 * Tool names with side effects — file writes, subagent/task delegation, and
 * conversation compaction. In `plan` mode these are stripped from the toolset
 * so the agent can only research/plan, not modify anything.
 *
 * NOTE: `execute` (shell) is deliberately NOT in this set. Plan mode needs Bash
 * for codebase search (`rg`/`find`/`ls`), since the dedicated search tools
 * (`ls`/`glob`/`grep`) are removed by FilesystemPolicyMiddleware to avoid tool
 * overlap (ZCode-style architecture). Shell file writes are still blocked by
 * `FileEditGuardMiddleware` in plan/confirm/auto modes (only `full` bypasses),
 * and `execute` remains HITL-gated via `_addInterruptOn()`.
 *
 * Read-only tools (read_file, grep_search, web_search, fetch_url) are safe in
 * every mode and need no gating.
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
