import { Bot } from "lucide-react";
import { useChatStore } from "../../../stores/chat.js";
import type { SubagentEvent } from "../turn/types.js";

/**
 * Subagent activity badge for the chat header.
 *
 * Mirrors `TodoBadge`: a compact badge that only renders when the conversation
 * has at least one subagent (`task` tool) event. Shows an icon + the total
 * count and color-codes by lifecycle — blue while any subagent is still
 * streaming, green once all are done. Clicking it opens the right-side
 * companion panel and auto-activates the "子智能体" tab (see SubagentPanel).
 *
 * Data source: the caller passes the flattened `allSubagents` list derived
 * across the whole conversation (see useChat.ts).
 */
export function SubagentBadge({ subagents }: { subagents: SubagentEvent[] }) {
  const openCompanionTab = useChatStore((s) => s.openCompanionTab);

  if (subagents.length === 0) return null;

  const total = subagents.length;
  const streaming = subagents.filter((s) => s.status === "streaming").length;
  const active = streaming > 0;

  // Badge color by lifecycle.
  const color = active
    ? "var(--color-info-700)"
    : "var(--color-success-700)";

  const title = active
    ? `子智能体 · ${streaming} 个执行中 / 共 ${total}`
    : `子智能体 · ${total} 个已完成`;

  const openCompanion = () => {
    openCompanionTab("subagents");
  };

  return (
    <button
      type="button"
      title={title}
      onClick={openCompanion}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12,
        lineHeight: "20px",
        padding: "0 8px",
        borderRadius: 4,
        border: "1px solid var(--gray-200)",
        background: "transparent",
        color,
        cursor: "pointer",
      }}
    >
      <Bot style={{ fontSize: 13 }} />
      <span>{total}</span>
    </button>
  );
}
