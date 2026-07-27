import { useState } from "react";
import { Collapse } from "antd";
import { CaretRightOutlined } from "@ant-design/icons";
import type { ReasoningEvent } from "./types.js";

/**
 * A single reasoning (thinking) span in the turn timeline.
 *
 * Minimal visual treatment — no background or border, just a small caret +
 * label, so the thinking trace stays unobtrusive next to the reply. The block
 * is always collapsed by default (whether streaming or finished); the user
 * clicks to expand if they want to read the reasoning.
 *
 * Multiple reasoning events in one turn each render as an independent block
 * (they represent separate thinking episodes between tool calls); merging them
 * would lose the causal context of "thought here, then called a tool".
 */
export function ReasoningBlock({
  event,
  isActive,
}: {
  event: ReasoningEvent;
  /** Whether the parent turn is still streaming. Only affects the label. */
  isActive?: boolean;
}) {
  // Always collapsed by default — the user opts in to reading the reasoning.
  const [expanded, setExpanded] = useState<boolean>(false);

  const label = isActive ? "正在思考..." : "思考过程";

  return (
    <Collapse
      ghost
      size="small"
      activeKey={expanded ? [event.id] : []}
      onChange={(keys) => setExpanded(keys.length > 0)}
      expandIcon={({ isActive: open }) => (
        <CaretRightOutlined rotate={open ? 90 : 0} style={{ fontSize: 11 }} />
      )}
      style={{ background: "transparent" }}
      items={[
        {
          key: event.id,
          label: (
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--gray-500)",
                letterSpacing: "0.025em",
              }}
            >
              {label}
            </span>
          ),
          children: (
            <div
              style={{
                fontSize: 13,
                color: "var(--gray-500)",
                fontStyle: "italic",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {event.text || (isActive ? "…" : "(空)")}
            </div>
          ),
        },
      ]}
    />
  );
}
