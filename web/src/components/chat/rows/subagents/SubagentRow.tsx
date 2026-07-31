import {
  CheckCircleFilled,
  LoadingOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { truncate } from "../../../widgets/utils.js";
import type { SubagentEvent } from "../../turn/types.js";

/**
 * A compact, single-line row representing a subagent (`task` tool) invocation
 * in the main conversation turn.
 *
 * The subagent's internal execution detail is NOT shown inline — it lives in
 * the side panel (SubagentPanel). Clicking this row selects the subagent and
 * opens the panel. This keeps the main turn uncluttered while the full nested
 * events remain one click away.
 *
 * The row mirrors the visual weight of the tool-call group bar: no border —
 * just a compact summary line (status icon + friendly name + description +
 * tool-count tag). It is the subagent counterpart of ToolCallRow.
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
  const tools = event.events.filter((e) => e.type === "tool");
  const toolCount = tools.length;
  const streaming = event.status === "streaming";
  const active = isActive ?? streaming;

  const statusIcon = streaming ? (
    <LoadingOutlined style={{ color: "var(--color-info-700)" }} />
  ) : (
    <CheckCircleFilled style={{ color: "var(--gray-400)" }} />
  );

  const uniqueNames = Array.from(new Set(tools.map((t) => (t.type === "tool" ? t.entry.name : ""))));
  const visibleNames = uniqueNames.slice(0, 3);

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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        fontWeight: 500,
        color: "var(--gray-500)",
        letterSpacing: "0.025em",
        flexWrap: "wrap",
        cursor: "pointer",
        padding: "4px 6px",
        borderRadius: 6,
        transition: "background 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--gray-50)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {statusIcon}
      <RobotOutlined style={{ fontSize: 12 }} />
      <span style={{ color: "var(--gray-700)" }}>
        {event.displayName || event.agentNs || "未命名子智能体"}
      </span>
      {event.description && (
        <span
          title={event.description}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--gray-400)",
            maxWidth: 320,
          }}
        >
          {truncate(event.description, 40)}
        </span>
      )}
      {visibleNames.map((n) => (
        <span
          key={n}
          style={{
            fontSize: 11,
            lineHeight: "18px",
            background: "transparent",
            border: "1px solid var(--gray-200)",
            color: "var(--gray-500)",
            padding: "0 6px",
            borderRadius: 4,
          }}
        >
          {n}
        </span>
      ))}
      {uniqueNames.length > visibleNames.length && (
        <span style={{ fontSize: 11, color: "var(--gray-400)" }}>
          +{uniqueNames.length - visibleNames.length}
        </span>
      )}
      <span style={{ marginLeft: "auto", fontSize: 11 }}>
        <span style={{ color: streaming ? "var(--color-info-700)" : "var(--color-success-700)" }}>
          {active
            ? toolCount > 0
              ? `执行中 · ${toolCount} 个工具`
              : "执行中"
            : toolCount > 0
              ? `完成 · ${toolCount} 个工具`
              : "完成"}
        </span>
      </span>
    </div>
  );
}
