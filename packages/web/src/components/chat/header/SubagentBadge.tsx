import { Bot } from "lucide-react";
import { useChatStore } from "../../../stores/chat.js";
import type { SubagentEvent } from "../turn/types.js";

/**
 * Subagent activity badge for the chat header.
 *
 * Mirrors `TodoBadge`: a compact neutral pill that only renders when the
 * conversation has at least one subagent (`task` tool) event. The status dot
 * pulses while any subagent is still streaming and turns green once all are
 * done. Clicking it opens the right-side companion panel and auto-activates
 * the "子智能体" tab.
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
      className="pill focus-ring"
      style={{ cursor: "pointer" }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flexShrink: 0,
          background: active ? "var(--color-info-500)" : "var(--color-success-500)",
          animation: active ? "dotPulse 1.4s var(--ease) infinite" : undefined,
        }}
      />
      <Bot style={{ fontSize: 13, color: "var(--text-tertiary)" }} />
      <span className="tnum">{total}</span>
    </button>
  );
}
