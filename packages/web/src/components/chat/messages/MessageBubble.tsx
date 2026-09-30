import { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { message as antdMessage } from "antd";
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
 *  - user messages: a right-aligned **neutral** bubble (the accent is reserved
 *    for state, so the user's own words don't read as a highlighted system
 *    message);
 *  - assistant messages: full-width, unboxed, with the execution trail on a rail
 *    (TurnEvents) and the reply in plain prose.
 *
 * Hovering a row reveals its copy action. Also renders the legacy error hint
 * below the bubble when present.
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
  const isUser = msg.role === "user";

  return (
    <div
      className="msg-row"
      style={{
        display: "flex", flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        marginBottom: 20, position: "relative",
        animation: "fadeInUp var(--dur-3) var(--ease-out)",
        minWidth: 0, maxWidth: "100%",
      }}
    >
      {/* Reasoning + reply + tool calls.
          For assistant turns we render an ordered event sequence (TurnEvents)
          that preserves real execution order (reasoning → tool → reasoning →
          tool → reply) instead of the old type-grouped stacking. User messages
          keep the simple bubble. TurnEvents itself handles progressive disclosure
          (a finished turn folds its trail to one line). */}
      {!isUser && (
        <WorkTimer
          startedAtMs={msg.startedAtMs}
          durationMs={msg.workDurationMs}
          running={msg.status === "streaming"}
        />
      )}
      {!isUser && msg.events && msg.events.length > 0 ? (
        <TurnEvents
          events={msg.events}
          isActive={msg.status === "streaming"}
          onOpenSubagent={onOpenSubagent}
        />
      ) : (
        /* Fallback bubble for user messages, or assistant turns that predate the
           events model (empty timeline). */
        <div style={{
          maxWidth: isUser ? "78%" : "100%",
          padding: isUser ? "10px 14px" : "0",
          borderRadius: isUser ? "var(--radius-lg)" : 0,
          fontSize: "var(--text-md)", lineHeight: "25px",
          wordBreak: "break-word",
          ...(isUser
            ? {
                whiteSpace: "pre-wrap",
                background: "var(--bg-muted)",
                color: "var(--text-primary)",
              }
            : { color: "var(--text-primary)" }),
        }}>
          {isUser ? (
            msg.content
          ) : msg.content ? (
            <Markdown content={msg.content} />
          ) : (
            // Empty streaming bubble renders nothing — the work-timer meta line
            // at the top of the turn already signals the busy state.
            ""
          )}
          {/* User attachments — thumbnails / file cards below the text. */}
          {isUser && msg.attachments && msg.attachments.length > 0 && (
            <MessageAttachments attachments={msg.attachments} workspaceId={workspaceId} />
          )}
        </div>
      )}

      {/* Copy action — revealed on row hover. */}
      <MessageActions msg={msg} />

      {/* Error hint */}
      {msg.error && (
        <div style={{
          background: "var(--color-error-50)",
          border: "1px solid color-mix(in srgb, var(--color-error-500) 30%, transparent)",
          borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: "var(--text-sm)",
          color: "var(--color-error-700)", marginTop: 6,
          width: "100%",
        }}>
          {msg.error}
        </div>
      )}
    </div>
  );
}

/** The text a copy action should put on the clipboard for this message. */
function copyPayload(msg: Msg): string {
  if (msg.role === "user") return msg.content ?? "";
  const fromEvents = (msg.events ?? [])
    .filter((e) => e.type === "text")
    .map((e) => e.text)
    .join("\n\n");
  return fromEvents || msg.content || "";
}

/**
 * Per-message actions. Currently copy — the extension point for regenerate /
 * edit later. Hidden until the row is hovered (or focused) so the transcript
 * stays quiet; the CSS lives in theme.css (`.msg-actions`).
 */
function MessageActions({ msg }: { msg: Msg }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const payload = copyPayload(msg);
  if (!payload.trim()) return null;

  const onCopy = () => {
    navigator.clipboard?.writeText(payload).then(
      () => {
        setCopied(true);
        antdMessage.success({ content: "已复制", duration: 1.2 });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      },
      () => antdMessage.error("复制失败"),
    );
  };

  return (
    <div
      className="msg-actions"
      style={{
        display: "flex",
        gap: 2,
        marginTop: 6,
        justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
      }}
    >
      <button
        type="button"
        className="icon-btn focus-ring"
        style={{ width: 26, height: 26 }}
        title="复制"
        aria-label="复制"
        onClick={onCopy}
      >
        <span style={{ display: "flex", fontSize: 13 }}>
          {copied ? <Check /> : <Copy />}
        </span>
      </button>
    </div>
  );
}