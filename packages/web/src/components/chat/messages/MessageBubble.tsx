import { TurnEvents } from "../turn/TurnEvents.js";
import { Markdown } from "../../widgets/Markdown.js";
import { WorkTimer } from "../WorkTimer.js";
import { MessageAttachments } from "./MessageAttachments.js";
import type { SubagentEvent } from "../turn/types.js";
import type { Msg } from "../types.js";

/**
 * One message row in the conversation — either an assistant turn rendered as an
 * ordered event timeline (TurnEvents), or a simple fallback bubble (user text,
 * or an assistant turn that predates the events model).
 *
 * Also renders the legacy error hint below the bubble when present.
 *
 * The bubble's alignment and styling depend on `msg.role`:
 *  - user messages align right with a tinted bubble;
 *  - assistant messages align left, full-width (the timeline handles its own
 *    internal layout).
 *
 * Props are intentionally minimal — `onOpenSubagent` is forwarded to TurnEvents
 * so inline subagent chips can open a companion-panel tab for that run.
 */
export function MessageBubble({
  msg,
  onOpenSubagent,
  workspaceId,
}: {
  msg: Msg;
  onOpenSubagent: (ev: SubagentEvent) => void;
  /** Active workspace — lets history-loaded attachment thumbs fetch bytes. */
  workspaceId?: string;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: msg.role === "user" ? "flex-end" : "flex-start",
      marginBottom: 20, position: "relative",
      animation: "fadeInUp 0.3s ease-out",
      minWidth: 0, maxWidth: "100%",
    }}>
      {/* Reasoning + reply + tool calls.
          For assistant turns we now render an ordered event sequence (TurnEvents)
          that preserves real execution order (reasoning → tool → reasoning →
          tool → reply) instead of the old type-grouped stacking. User messages
          keep the simple bubble. TurnEvents itself handles progressive disclosure
          (long finished turns collapse their head) and per-type visual weight. */}
      {msg.role === "assistant" && (
        <WorkTimer
          startedAtMs={msg.startedAtMs}
          durationMs={msg.workDurationMs}
          running={msg.status === "streaming"}
        />
      )}
      {msg.role === "assistant" && msg.events && msg.events.length > 0 ? (
        <TurnEvents
          events={msg.events}
          isActive={msg.status === "streaming"}
          onOpenSubagent={onOpenSubagent}
        />
      ) : (
        /* Fallback bubble for user messages, or assistant turns that predate the
           events model (empty timeline). */
        <div style={{
          maxWidth: "95%",
          padding: msg.role === "user" ? "0.5rem 1rem" : "0",
          borderRadius: msg.role === "user" ? "0.5rem" : 0,
          fontSize: 15, lineHeight: "24px", letterSpacing: "0.25px",
          wordBreak: "break-word",
          ...(msg.role === "user"
            ? {
                whiteSpace: "pre-wrap",
                background: "var(--main-50)",
                color: "var(--gray-1000)",
              }
            : { color: "var(--gray-900)" }),
        }}>
          {msg.role === "user" ? (
            msg.content
          ) : msg.content ? (
            <Markdown content={msg.content} />
          ) : (
            // Empty streaming bubble renders nothing — the WorkTimer at the
            // top of the turn already signals the busy state.
            ""
          )}
          {/* User attachments — thumbnails / file cards below the text. */}
          {msg.role === "user" && msg.attachments && msg.attachments.length > 0 && (
            <MessageAttachments attachments={msg.attachments} workspaceId={workspaceId} />
          )}
        </div>
      )}

      {/* Error hint */}
      {msg.error && (
        <div style={{
          background: "var(--color-error-50)",
          border: "1px solid color-mix(in srgb, var(--color-error-500) 25%, transparent)",
          borderRadius: 8, padding: "6px 12px", fontSize: 13,
          color: "var(--color-error-500)", marginTop: 4,
          width: "100%",
        }}>
          {msg.error}
        </div>
      )}
    </div>
  );
}
