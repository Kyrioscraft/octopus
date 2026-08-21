import { useState } from "react";
import type { ReasoningEvent } from "../turn/types.js";
import { Collapse } from "antd";
import { BrainCircuit } from "lucide-react";

/**
 * A collapsible reasoning (thinking) block — one "thinking episode" of an
 * assistant turn.
 *
 * Visual weight: lowest of the timeline (process info, amber-tinted, small).
 * While the turn is streaming (`isActive`) it defaults to expanded so the
 * user sees live thinking; once the turn finishes it folds to a one-line
 * summary ("思考中…" / "思考了 Ns"), à la Claude.ai.
 */
export function ReasoningBlock({
  event,
  isActive,
}: {
  event: ReasoningEvent;
  /** Whether the parent turn is still streaming (drives default expansion). */
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
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--gray-500)",
                  letterSpacing: "0.025em",
                }}
              >
                {isActive ? (                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#d97706",
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <BrainCircuit size={13} style={{ color: "var(--gray-400)" }} />
                )}
                <span>{summary}</span>
              </div>
            ),
            children: (
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: "20px",
                  color: "var(--gray-600)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  paddingLeft: 6,
                  borderLeft: "2px solid rgba(217, 119, 6, 0.35)",
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
