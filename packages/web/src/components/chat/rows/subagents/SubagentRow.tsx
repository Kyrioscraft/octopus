import {
  Bot,
  ChevronRight,
} from "lucide-react";
import { truncate } from "../../../widgets/utils.js";
import type { SubagentEvent } from "../../turn/types.js";

/**
 * A compact, single-line row representing a subagent (`task` tool) invocation
 * in the main conversation turn.
 *
 * Layout: [robot tile] 子智能体 [name] [intent] [chevron].
 *   - the icon sits in a small rounded tile with a soft accent fill, which
 *     separates subagent work from the plain tool rows around it at a glance;
 *   - name — the subagent TYPE (e.g. "Explore"), the executed subagent;
 *   - intent — the task call's `description`, muted and truncated;
 *   - chevron — revealed on hover, signalling that the row opens the side panel.
 *
 * The subagent's internal execution detail is NOT shown inline — it lives in the
 * side panel (SubagentPanel). Clicking this row selects the subagent and opens
 * the panel. The running state is carried by the trace rail's status dot, so no
 * spinner here (mirrors ToolCallRow).
 */
export function SubagentRow({
  event,
  isActive,
  onOpen,
}: {
  event: SubagentEvent;
  /** Whether the parent turn is still streaming. */
  isActive?: boolean;
  /** Called when the user clicks the row — opens the side panel on this subagent. */
  onOpen?: (event: SubagentEvent) => void;
}) {
  // `isActive` reflects the parent turn's streaming state; the row's own
  // streaming flag is surfaced via the rail dot by the caller.
  void isActive;

  const intent = event.description?.trim();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(event)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(event);
        }
      }}
      className="trace-head focus-ring"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: "var(--text-sm)",
        minWidth: 0,
        cursor: "pointer",
        padding: "4px 6px",
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "var(--radius-xs)",
          background: "var(--accent-soft)",
          color: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <Bot />
      </span>
      <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>子智能体</span>
      <span style={{ color: "var(--text-primary)", fontWeight: 500, flexShrink: 0 }}>
        {event.displayName || event.agentNs || "未命名子智能体"}
      </span>
      {intent && (
        <span
          title={intent}
          className="truncate"
          style={{ color: "var(--text-tertiary)", minWidth: 0 }}
        >
          {truncate(intent, 60)}
        </span>
      )}
      <span
        className="row-chevron"
        style={{ display: "flex", fontSize: 13, color: "var(--text-disabled)", flexShrink: 0 }}
      >
        <ChevronRight />
      </span>
    </div>
  );
}