import type { RefObject } from "react";
import { Loader } from "lucide-react";
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
  workspaceId,
}: {
  msgs: Msg[];
  busy: boolean;
  endRef: RefObject<HTMLDivElement | null>;
  onOpenSubagent: (ev: SubagentEvent) => void;
  /** Active workspace — forwarded for history attachment preview fetching. */
  workspaceId?: string;
}) {
  return (
    <div style={{ padding: "1rem 1.5rem" }}>
      <div style={{ maxWidth: 800, width: "100%", margin: "0 auto" }}>
        {msgs.map((m) => (
          <MessageBubble key={m.id} msg={m} onOpenSubagent={onOpenSubagent} workspaceId={workspaceId} />
        ))}
        {/* Running indicator — always visible at the bottom while busy
            (zcode-style): a spinning lucide Loader icon, even after the
            assistant has produced content — the turn is still executing
            (streaming, tool calls, subagents). */}
        {busy && msgs.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center",
            // paddingLeft matches the text event's 6px indent (EventRow) so the
            // loader lines up under the reply text, not the container edge.
            padding: "0.5rem 0 0.5rem 6px", animation: "fadeInUp 0.4s ease-out",
          }}>
            <Loader
              size={18}
              style={{ color: "var(--gray-400)", animation: "spin 0.8s linear infinite" }}
            />
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
