import { useState } from "react";
import type { ReasoningEvent } from "../turn/types.js";
import { Collapse } from "antd";
import { BrainCircuit } from "lucide-react";

/**
 * A collapsible reasoning (thinking) block — one "thinking episode" of an
 * assistant turn.
 *
 * Visual weight: lowest in the timeline. The "still thinking" signal lives on the
 * trace rail's status dot, so the header itself stays a plain muted label
 * ("思考中…" / "思考了 Ns") with the body behind a click.
 */
export function ReasoningBlock({
  event,
  isActive,
}: {
  event: ReasoningEvent;
  /** Whether the parent turn is still streaming (used for the label copy). */
  isActive?: boolean;
}) {
  // Always collapsed by default — user clicks to expand (matches ToolGroupBar).
  const [expanded, setExpanded] = useState<boolean>(false);

  // Frozen duration once the episode ended (endedAt set by closeReasoning);
  // live-ticking while still thinking. Historical replays (startedAt === 0)
  // have no timing — show just "思考过程" without seconds.
  const ended = event.endedAt !== undefined || event.startedAt === 0;
  const elapsedSec =
    event.endedAt !== undefined && event.startedAt > 0
      ? Math.max(0, Math.round((event.endedAt - event.startedAt) / 1000))
      : Math.max(0, Math.round((Date.now() - event.startedAt) / 1000));
  const summary = !ended
    ? "思考中…"
    : event.startedAt > 0
      ? `思考了 ${elapsedSec}s`
      : "思考过程";

  return (
    <div className={`collapsible-row${expanded ? " is-expanded" : ""}`}>
      <Collapse
        ghost
        size="small"
        activeKey={expanded ? ["r"] : []}
        onChange={(keys) => setExpanded(keys.length > 0)}
        expandIconPosition="end"
        style={{ background: "transparent" }}
        items={[
          {
            key: "r",
            label: (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                }}
              >
                <BrainCircuit size={13} style={{ color: "var(--text-disabled)", flexShrink: 0 }} />
                <span className={ended && event.startedAt > 0 ? "tnum" : undefined}>
                  {summary}
                </span>
              </div>
            ),
            children: (
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: "20px",
                  color: "var(--text-tertiary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  paddingLeft: 10,
                  paddingBlock: 2,
                  borderLeft: "1px solid var(--border-subtle)",
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                {event.text || "…"}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
