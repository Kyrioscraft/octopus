import type { TurnEvent, ToolEvent } from "./types.js";
import { isExplorationCall } from "../rows/tools/registry.js";

// =============================================================================
// projectTurnParts — the derived layer (pure function).
//
// Single implementation of the presentation ViewModel shared by BOTH the live
// timeline and history rendering: it consumes the raw `TurnEvent[]` timeline
// (built by TurnEventAccumulator from wire events — the raw layer) and
// produces the grouped view items. Because both paths run the same pure
// projection over the same raw input, "历史显示与实时输出一致" holds by
// construction.
//
// Invariant (asserted by test_project.mjs): feeding events incrementally and
// re-projecting must equal a full recompute — no accumulator state may leak
// into the projection.
//
// Grouping policy:
//   - Only **exploration calls** merge: exploration tool names (read_file /
//     list_directory / ls / glob / grep / search_file_content / grep_search /
//     rg / find — data-driven below) plus shell calls that run a bare
//     read-only search command (ls / grep / rg / find / …). A contiguous run
//     of them collapses into one "探索组" summary row.
//   - Every other tool (edit / write / execute / web_search / task /
//     ask_user_question / …) renders as its own full tool row, never grouped.
//   - Reasoning follows ZCode's first-reasoning-row semantics by default;
//   - ask / write_todos are not rendered in the timeline.
// =============================================================================

/** A run of consecutive exploration-tool events, flattened for grouped rendering. */
export interface ToolGroup {
  kind: "tool-group";
  id: string;
  tools: ToolEvent[];
}
/** Anything that isn't an exploration-tool run renders on its own. */
export interface SingleItem {
  kind: "single";
  event: TurnEvent;
}
export type TurnItem = ToolGroup | SingleItem;

/**
 * Partition a turn's raw timeline into view items. Pure — same input, same
 * output, no React/DOM/store access. See the header comment for the policy.
 */
export function projectTurnParts(
  events: TurnEvent[],
  opts?: { showAllReasoning?: boolean },
): TurnItem[] {
  const items: TurnItem[] = [];
  let i = 0;
  let groupSeq = 0;
  // 只保留会被渲染的事件类型；ask / write_todos 在时间线中不显示。
  // reasoning 默认仅显示每轮第一个（ZCode messageStreamShowReasoning 语义）。
  // write_todos 的进度改由输入栏的待办徽章承载（TodoBadge）。
  const firstReasoningId = events.find((ev) => ev.type === "reasoning")?.id;
  const visible = events.filter(
    (ev) =>
      (ev.type !== "reasoning" || opts?.showAllReasoning || ev.id === firstReasoningId) &&
      ev.type !== "ask" &&
      !(ev.type === "tool" && ev.entry.name === "write_todos"),
  );
  while (i < visible.length) {
    const ev = visible[i];
    if (ev.type === "tool" && isExplorationCall(ev.entry)) {
      // Gather the contiguous run of exploration calls.
      const tools: ToolEvent[] = [];
      while (i < visible.length && visible[i].type === "tool" && isExplorationCall((visible[i] as ToolEvent).entry)) {
        tools.push(visible[i] as ToolEvent);
        i++;
      }
      items.push({ kind: "tool-group", id: `tg_${groupSeq++}`, tools });
    } else {
      // Non-exploration tool, or a non-tool event → render on its own.
      items.push({ kind: "single", event: ev });
      i++;
    }
  }
  return items;
}
