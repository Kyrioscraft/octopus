/**
 * Permission evaluation — findLast rule resolution over a Ruleset.
 *
 * Equivalent to opencode's Permission.evaluate
 * (packages/opencode/src/permission/index.ts:28-38): the LAST rule whose
 * permission selector AND pattern both match wins; no match → the fail-safe
 * default "ask". Ruleset order is therefore priority: defaults first,
 * exceptions last (agent preset → user global → thread/session → runtime
 * approvals, concatenated in that order by the caller).
 */

import {
  type Ruleset,
  type PermissionAction,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionRule,
} from "./types.js";
import { wildcardMatch } from "./wildcard.js";

/** The decision returned when no rule matches — ask (fail-safe). */
export const DEFAULT_DECISION_ACTION: PermissionAction = "ask";

/**
 * Evaluate a permission query against one or more rulesets. The rulesets are
 * concatenated in argument order; the last matching rule across all of them
 * wins. This mirrors opencode: `evaluate(permission, pattern, defaults,
 * agentRules, sessionRules, approved)`.
 */
export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: (Ruleset | undefined)[]
): PermissionDecision {
  const flat = rulesets.flat();
  for (let i = flat.length - 1; i >= 0; i--) {
    const rule = flat[i];
    if (!rule) continue;
    if (
      wildcardMatch(rule.permission, permission) &&
      wildcardMatch(rule.pattern, pattern)
    ) {
      return { action: rule.action, rule, permission, pattern };
    }
  }
  return { action: DEFAULT_DECISION_ACTION, rule: null, permission, pattern };
}

/**
 * Flatten a user-facing PermissionConfig into a Ruleset. Key order is
 * preserved (object insertion order) so "defaults first, exceptions last"
 * reads naturally in config files:
 *
 *   { edit: { "*": "deny", "docs/**": "allow" } }
 *     → [{edit,*:deny}, {edit,docs/**:allow}]
 */
export function rulesetFromConfig(config: PermissionConfig): Ruleset {
  const rules: PermissionRule[] = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value });
    } else {
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({ permission, pattern, action });
      }
    }
  }
  return rules;
}

/**
 * Find tools that are STATICALLY disabled — a rule with action "deny" whose
 * pattern is exactly "*" removes the tool from the LLM's toolset entirely
 * (the model never sees it). Narrower denies stay in the toolset and throw
 * at call time (the model gets feedback it can act on).
 *
 * Equivalent to opencode's Permission.disabled (permission/index.ts:204-219).
 */
export function staticallyDisabledTools(ruleset: Ruleset): Set<string> {
  const disabled = new Set<string>();
  for (const rule of ruleset) {
    if (rule.action === "deny" && rule.pattern === "*") {
      // Exact tool names only — a wildcard permission with pattern "*" would
      // deny everything, which presets express differently (empty toolset
      // filtering already handles that case in makeGraph).
      if (!rule.permission.includes("*")) disabled.add(rule.permission);
    }
  }
  return disabled;
}
