import type { RefObject } from "react";
import type { SubagentEvent } from "../turn/types.js";
import type { Msg } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";

/**
 * The scrollable conversation message list.
 *
 * Renders each message via <MessageBubble>, plus a three-dot "working" indicator
 * while the assistant is busy (covering the window before a turn row exists),
 * and a scroll-to-bottom anchor (`endRef`) at the very bottom so the view can
 * auto-scroll on new content.
 *
 * The column runs on the shared `--content-max` width so messages and the
 * composer are edge-aligned. Scrolling is handled by the parent container
 * (overflow-y: auto) — this component provides the padded, centred content.
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
    // The large bottom inset reserves room for the composer, which floats over
    // the transcript (see pages/Chat.tsx). Keep the two in step.
    <div style={{ padding: "24px 24px 148px" }}>
      <div style={{ maxWidth: "var(--content-max)", width: "100%", margin: "0 auto" }}>
        {msgs.map((m) => (
          <MessageBubble key={m.id} msg={m} onOpenSubagent={onOpenSubagent} workspaceId={workspaceId} />
        ))}
        {/* Working indicator — visible at the bottom for as long as the turn is
            executing (streaming, tool calls, subagents). Purely decorative:
            the per-turn work timer carries the elapsed time. */}
        {busy && msgs.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              height: 24,
              paddingLeft: 2,
              animation: "fadeIn var(--dur-3) var(--ease-out)",
            }}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--accent-solid)",
                  animation: `dotPulse 1.4s var(--ease) ${i * 0.16}s infinite`,
                }}
              />
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}