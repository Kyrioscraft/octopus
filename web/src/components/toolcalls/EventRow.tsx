import type { TurnEvent } from "./types.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { ToolCallRenderer } from "./ToolCallRenderer.js";
import { Markdown } from "../Markdown.js";
import { summarizeResolution } from "../AskPanel.js";
import { RobotOutlined } from "@ant-design/icons";
import { Collapse } from "antd";
import { CaretRightOutlined } from "@ant-design/icons";
import { useState } from "react";
import { truncate } from "./registry.js";

/**
 * Dispatch a single timeline event to its specialized renderer.
 *
 * Mirrors Cline's ChatRow pattern: one switch on event.type, each branch
 * rendering a purpose-built component. Keeping this dispatch centralized is
 * what lets the timeline stay ordered and readable regardless of how the
 * events interleave.
 *
 * Visual weight hierarchy (so the "final reply" stands out from process info):
 *   - reasoning → amber, small, collapsible (process)
 *   - tool      → gray card, collapsible (process)
 *   - subagent  → indented gray card, collapsible (process)
 *   - text      → no card, full width, primary font (the answer)
 */
export function EventRow({
  event,
  isActive,
}: {
  event: TurnEvent;
  /** Whether the parent turn is streaming (drives default expansion). */
  isActive?: boolean;
}) {
  switch (event.type) {
    case "reasoning":
      return <ReasoningBlock event={event} isActive={isActive} />;

    case "tool":
      return <ToolCallRenderer entry={event.entry} defaultExpanded={isActive} />;

    case "text":
      // The final reply — highest visual weight, no card wrapper.
      return (
        <div
          style={{
            fontSize: 15,
            lineHeight: "24px",
            letterSpacing: "0.25px",
            color: "var(--gray-900)",
            wordBreak: "break-word",
            // Slight left padding to align with the timeline rail without a card.
            paddingLeft: 6,
          }}
        >
          <Markdown content={event.text} />
        </div>
      );

    case "subagent":
      return <SubagentRow event={event} isActive={isActive} />;

    case "ask":
      // Read-only trace of an ask_user_question_required pause. The
      // interactive UI lives in the input-area AskPanel; this row only
      // records the question + its outcome once the user answers.
      return <AskTraceRow event={event} />;

    default:
      // Exhaustive switch guard — if a new event type is added without a
      // branch here, this surfaces it visibly.
      return null;
  }
}

/**
 * Subagent (task tool) row — flat design. Shows the subagent type +
 * description; expandable to reveal the subagent's final result text.
 * Indented slightly and given a robot icon to distinguish it from regular
 * tool calls.
 */
function SubagentRow({
  event,
  isActive,
}: {
  event: Extract<TurnEvent, { type: "subagent" }>;
  isActive?: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>(isActive ?? false);

  return (
    <div
      style={{
        borderLeft: "2px solid var(--main-200)",
        background: "var(--main-10)",
        borderRadius: "0 6px 6px 0",
        marginLeft: 4,
      }}
    >
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
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--main-700)",
                  letterSpacing: "0.025em",
                  minWidth: 0,
                }}
              >
                <RobotOutlined />
                <span>{event.agentNs}</span>
                {event.description && (
                  <>
                    <span style={{ color: "var(--gray-300)" }}>|</span>
                    <span
                      title={event.description}
                      style={{
                        color: "var(--gray-500)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {truncate(event.description, 50)}
                    </span>
                  </>
                )}
                {!event.result && isActive && (
                  <span style={{ color: "var(--gray-400)", fontStyle: "italic" }}>
                    执行中…
                  </span>
                )}
              </span>
            ),
            children: event.result ? (
              <div style={{ paddingLeft: 6 }}>
                <Markdown content={event.result} />
              </div>
            ) : (
              <div style={{ paddingLeft: 6, color: "var(--gray-500)", fontStyle: "italic" }}>
                {isActive ? "子智能体执行中…" : "(无结果)"}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * Read-only trace row for an AskEvent. Records that the agent paused to ask
 * the user something (tool approval / discussion / clarification). The
 * interactive UI lives in the input-area AskPanel — this row only surfaces
 * the question text and, once resolved, the outcome summary.
 *
 * Color-coded by kind (warning=approval, info=discussion, green=clarify) so
 * the timeline visually distinguishes the three ask flavors.
 */
function AskTraceRow({ event }: { event: Extract<TurnEvent, { type: "ask" }> }) {
  const accent =
    event.kind === "tool_approval"
      ? "var(--color-warning-500)"
      : event.kind === "discussion"
        ? "var(--color-info-500)"
        : "var(--main-500)";
  const bg =
    event.kind === "tool_approval"
      ? "var(--color-warning-50)"
      : event.kind === "discussion"
        ? "var(--color-info-50)"
        : "var(--main-10)";
  const summary = summarizeResolution(event.kind, event.questions, event.resolution);

  return (
    <div
      style={{
        borderLeft: `2px solid ${accent}`,
        background: bg,
        borderRadius: "0 6px 6px 0",
        padding: "6px 10px",
        fontSize: 12,
        color: "var(--gray-700)",
      }}
    >
      <span style={{ fontWeight: 500, color: "var(--gray-900)" }}>
        {event.kind === "tool_approval" ? "工具审批" : event.kind === "discussion" ? "方案提问" : "澄清提问"}
      </span>
      {event.questions.length > 0 && event.questions[0].question && (
        <span style={{ marginLeft: 6 }}>
          · {truncate(event.questions[0].question, 60)}
        </span>
      )}
      <span style={{ marginLeft: 8, color: event.resolved ? "var(--gray-600)" : "var(--gray-400)" }}>
        {summary}
      </span>
    </div>
  );
}
