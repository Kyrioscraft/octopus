import type { TurnEvent, SubagentEvent } from "./types.js";
import { ToolCallRenderer } from "../rows/tools/ToolCallRenderer.js";
import { Markdown } from "../../widgets/Markdown.js";
import { SubagentRow } from "../rows/subagents/SubagentRow.js";
import { ReasoningBlock } from "../rows/ReasoningBlock.js";

/**
 * Dispatch a single turn event to its specialized renderer.
 *
 * Mirrors Cline's ChatRow pattern: one switch on event.type, each branch
 * rendering a purpose-built component. Keeping this dispatch centralized is
 * what lets the turn stay ordered and readable regardless of how the
 * events interleave.
 *
 * Visual weight hierarchy (so the "final reply" stands out from process info):
 *   - reasoning → small, muted, collapsible (process)
 *   - tool      → muted rail row, collapsible (process)
 *   - subagent  → compact row; detail opens in the side panel (process)
 *   - text      → full width, primary colour, no chrome (the answer)
 *
 * The process rows are wrapped by TurnEvents in a rail with a status dot per
 * entry; this file only renders the row itself.
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
      // 默认仅渲染每轮第一个思考块（groupEvents 已过滤后续块），
      // 全量开关见 stores/display.ts（messageStreamShowReasoning 语义）。
      return <ReasoningBlock event={event} isActive={isActive} />;

    case "tool":
      return <ToolCallRenderer entry={event.entry} defaultExpanded={isActive} />;

    case "text":
      // The final reply — highest visual weight. Normally rendered by
      // TurnEvents.AnswerBlock (outside the rail); this branch keeps EventRow
      // usable standalone.
      return (
        <div
          style={{
            fontSize: "var(--text-md)",
            lineHeight: "26px",
            letterSpacing: "0.01em",
            color: "var(--text-primary)",
            wordBreak: "break-word",
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
