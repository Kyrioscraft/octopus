import type { TurnEvent, SubagentEvent } from "./types.js";
import { ToolCallRenderer } from "../rows/tools/ToolCallRenderer.js";
import { Markdown } from "../../widgets/Markdown.js";
import { SubagentRow } from "../rows/subagents/SubagentRow.js";

/**
 * Dispatch a single turn event to its specialized renderer.
 *
 * Mirrors Cline's ChatRow pattern: one switch on event.type, each branch
 * rendering a purpose-built component. Keeping this dispatch centralized is
 * what lets the turn stay ordered and readable regardless of how the
 * events interleave.
 *
 * Visual weight hierarchy (so the "final reply" stands out from process info):
 *   - reasoning → amber, small, collapsible (process)
 *   - tool      → gray row, collapsible (process)
 *   - subagent  → compact row; detail opens in the side panel (process)
 *   - text      → no row, full width, primary font (the answer)
 */
export function EventRow({
  event,
  isActive,
  onOpenSubagent,
}: {
  event: TurnEvent;
  /** Whether the parent turn is streaming (drives default expansion). */
  isActive?: boolean;
  /** Opens the side panel on a subagent row click. Optional — nested
   *  event lists (inside the side panel) omit it. */
  onOpenSubagent?: (event: SubagentEvent) => void;
}) {
  switch (event.type) {
    case "reasoning":
      // 思考内容不在对话回合中显示（仅保留在 events[] 数据中）。
      return null;

    case "tool":
      return <ToolCallRenderer entry={event.entry} defaultExpanded={isActive} />;

    case "text":
      // The final reply — highest visual weight, no row wrapper.
      return (
        <div
          style={{
            fontSize: 15,
            lineHeight: "24px",
            letterSpacing: "0.25px",
            color: "var(--gray-900)",
            wordBreak: "break-word",
            paddingLeft: 6,
          }}
        >
          <Markdown content={event.text} />
        </div>
      );

    case "subagent":
      return (
        <SubagentRow event={event} isActive={isActive} onOpen={onOpenSubagent} />
      );

    case "ask":
      // 工具审批结果仅作为只读追溯记录；不在对话回合中渲染，避免视觉噪音。
      // 交互式 UI 仍由输入区的 AskPanel 处理，此处只返回 null 屏蔽显示。
      return null;

    default:
      // Exhaustive switch guard — if a new event type is added without a
      // branch here, this surfaces it visibly.
      return null;
  }
}
