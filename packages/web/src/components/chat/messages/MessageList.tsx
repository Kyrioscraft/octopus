import type { RefObject } from "react";
import type { SubagentEvent } from "../turn/types.js";
import type { Msg } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";

/**
 * The scrollable conversation message list.
 *
 * Renders each message via <MessageBubble>, plus a "generating…" indicator
 * when the assistant is busy but hasn't produced content yet (e.g. before the
 * first reasoning token arrives), and a scroll-to-bottom anchor (`endRef`) at
 * the very bottom so the view can auto-scroll on new content.
 *
 * The list is centered with a max width of 800px for readability. Scrolling is
 * handled by the parent container (overflow-y: auto) — this component just
 * provides the padded, centered content.
 */
export function MessageList({
  msgs,
  busy,
  endRef,
  onOpenSubagent,
}: {
  msgs: Msg[];
  busy: boolean;
  endRef: RefObject<HTMLDivElement | null>;
  onOpenSubagent: (ev: SubagentEvent) => void;
}) {
  return (
    <div style={{ padding: "1rem 1.5rem" }}>
      <div style={{ maxWidth: 800, width: "100%", margin: "0 auto" }}>
        {msgs.map((m) => (
          <MessageBubble key={m.id} msg={m} onOpenSubagent={onOpenSubagent} />
        ))}
        {/* Generating indicator when AI is busy but has no content yet */}
        {busy && msgs.length > 0 && msgs[msgs.length - 1]?.role !== "assistant" && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "0.5rem 0", animation: "fadeInUp 0.4s ease-out",
          }}>
            <div style={{
              width: 20, height: 20, borderRadius: "50%",
              border: "2px solid var(--gray-200)",
              borderTopColor: "var(--main-color)",
              animation: "spin 0.8s linear infinite",
            }} />
            <span style={{
              fontSize: 14, fontWeight: 500, letterSpacing: "0.025em",
              background: "linear-gradient(90deg, var(--gray-700) 0%, var(--gray-700) 40%, var(--gray-300) 45%, var(--gray-200) 50%, var(--gray-300) 55%, var(--gray-700) 60%, var(--gray-700) 100%)",
              backgroundSize: "200% auto",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              animation: "waveFlash 2s linear infinite",
            }}>
              正在生成回复...
            </span>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
