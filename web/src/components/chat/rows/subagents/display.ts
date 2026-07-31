/**
 * Friendly, localized display name for a subagent, keyed by its `agentNs`
 * (the deepagents subagent_type). Built-in subagents get a Chinese label;
 * user-defined subagents fall back to their raw name (title-cased for a
 * slightly nicer look when the name is a simple identifier). A missing
 * agentNs yields "未命名子智能体" rather than a generic label, so an
 * unidentified subagent is visibly distinct instead of masquerading as a
 * normal one.
 *
 * Used by the companion SubagentPanel (side panel). Note: the inline
 * SubagentRow renders the raw `agentNs` directly (no localization) to match
 * the user's preference for seeing the original identifier in the timeline.
 */
export function getSubagentDisplayName(agentNs: string | undefined | null): string {
  if (!agentNs) return "未命名子智能体";
  const map: Record<string, string> = {
    Explore: "探索智能体",
    "general-purpose": "通用智能体",
  };
  if (map[agentNs]) return map[agentNs];
  // User-defined subagent: fall back to the raw name, title-cased if it looks
  // like a simple lowercase identifier (e.g. "researcher" → "Researcher").
  if (/^[a-z0-9-]+$/.test(agentNs)) {
    return agentNs.charAt(0).toUpperCase() + agentNs.slice(1);
  }
  return agentNs;
}
