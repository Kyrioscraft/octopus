/**
 * Permission types — the pattern-based permission system (phase 2 of the
 * agent migration, see architecture/AGENT_MIGRATION_PLAN.md).
 *
 * Modeled after opencode's PermissionV1 (packages/opencode/src/permission/):
 * a Ruleset is an ordered list of rules; each rule matches a permission
 * (tool name, wildcard-able) plus an optional pattern (argument fragment —
 * file path, command prefix, ...) and resolves to an action:
 *
 *   - "allow": run without asking.
 *   - "ask"   : pause for HITL approval before running.
 *   - "deny"  : refuse. A `deny` on pattern "*" statically removes the tool
 *               from the LLM's toolset; a narrower deny throws at call time.
 *
 * Evaluation is findLast — later rules override earlier ones, so a Ruleset
 * reads as "defaults first, exceptions last". Unmatched → "ask" (fail-safe).
 */

/** What to do when a rule matches. */
export type PermissionAction = "allow" | "ask" | "deny";

/** One resolved rule. */
export interface PermissionRule {
  /** Permission selector — the tool name or a wildcard over it (e.g. "*", "task"). */
  permission: string;
  /** Argument pattern — "*" matches anything; may be a path/command glob. */
  pattern: string;
  action: PermissionAction;
}

/** An ordered rule list; last match wins. */
export type Ruleset = PermissionRule[];

/**
 * User-facing config shape before flattening into a Ruleset. Supports both
 * the terse form (`"bash": "ask"`) and per-pattern objects
 * (`"edit": { "*": "deny", "docs/**.md": "allow" }`).
 */
export type PermissionConfig = Record<
  string,
  PermissionAction | Record<string, PermissionAction>
>;

/** Result of evaluating a ruleset against a permission + pattern. */
export interface PermissionDecision {
  action: PermissionAction;
  /** The rule that produced the decision — null when falling to the default. */
  rule: PermissionRule | null;
  /** The permission that was queried (echoed for error messages / UI). */
  permission: string;
  /** The pattern that was queried. */
  pattern: string;
}

/** Error thrown when a tool call hits a `deny` rule. */
export class PermissionDeniedError extends Error {
  readonly rule: PermissionRule;
  constructor(rule: PermissionRule, permission: string, pattern: string) {
    super(
      `Permission denied: ${permission} on "${pattern}" is blocked by rule ` +
      `${rule.permission}:"${rule.pattern}" → deny`,
    );
    this.name = "PermissionDeniedError";
    this.rule = rule;
  }
}
