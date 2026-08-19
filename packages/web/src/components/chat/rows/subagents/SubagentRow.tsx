import {
  Loader,
  Bot,
} from "lucide-react";
import { truncate } from "../../../widgets/utils.js";
import type { SubagentEvent } from "../../turn/types.js";

/**
 * A compact, single-line row representing a subagent (`task` tool) invocation
 * in the main conversation turn.
 *
 * Layout: [status icon] [robot icon] 子智能体 [name] [intent].
 *   - "子智能体" — a fixed label after the icon, so the row is unmistakably a
 *     subagent invocation regardless of the agent's display name.
 *   - name — the subagent TYPE (e.g. "Explore"), the executed subagent.
 *   - intent — the task call's `description` (what the user/main agent asked it
 *     to do), shown in a darker-quiet color right after the name.
 *
 * The subagent's internal execution detail is NOT shown inline — it lives in
 * the side panel (SubagentPanel). Clicking this row selects the subagent and
 * opens the panel. No expand arrow / status text here: the row is a plain
 * clickable line (it is a <div>, not an antd Collapse).
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
  const streaming = event.status === "streaming";
  // `isActive` reflects the parent turn's streaming state; the row's own
  // streaming flag drives the spinner.
  void isActive;

  // Single-slot icon: spinner while streaming, the subagent (Bot) type icon
  // otherwise — dimmed so completion reads as "settled" (mirrors ToolCallRow).
  const leadIcon = streaming ? (
    <Loader
      size={14}
      style={{ color: "var(--gray-400)", animation: "spin 0.8s linear infinite" }}
    />
  ) : (
    <Bot style={{ fontSize: 13, color: "var(--gray-400)" }} />
  );

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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        fontWeight: 500,
        color: "var(--gray-500)",
        letterSpacing: "0.025em",
        minWidth: 0,
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
      {leadIcon}
      <span style={{ color: "var(--gray-400)", flexShrink: 0 }}>子智能体</span>
      <span style={{ color: "var(--gray-700)", flexShrink: 0 }}>
        {event.displayName || event.agentNs || "未命名子智能体"}
      </span>
      {intent && (
        <span
          title={intent}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--gray-400)",
            minWidth: 0,
          }}
        >
          {truncate(intent, 60)}
        </span>
      )}
    </div>
  );
}
