import { useState } from "react";
import type { TurnEvent, ToolEvent } from "./types.js";
import { EventRow } from "./EventRow.js";
import { ToolCallRenderer } from "./ToolCallRenderer.js";
import { Collapse, Tag } from "antd";
import { CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, LoadingOutlined, ClockCircleOutlined } from "@ant-design/icons";

/**
 * The ordered timeline of events for one assistant turn.
 *
 * Events render in real execution order, BUT consecutive tool events are
 * grouped into a single collapsible summary bar (yuxi-style): the folded
 * state shows one line ("已调用 N 个工具 · 全部完成") with a status indicator,
 * and clicking the arrow expands the individual tool records. This keeps a
 * turn that's mostly [推理 → 工具 → 工具 → 工具 → 推理 → 工具 → 回复] readable —
 * the tool noise collapses to two compact bars instead of N scattered cards.
 *
 * Design references: yuxi's ToolCallsGroupComponent (group + auto-expand while
 * streaming, auto-collapse when done), Windsurf's left rail (ties a turn
 * together), Claude.ai's visual hierarchy (reasoning de-emphasized, reply
 * emphasized with no card).
 */

/** A run of consecutive tool events, flattened for grouped rendering. */
interface ToolGroup {
  kind: "tool-group";
  id: string;
  tools: ToolEvent[];
}
/** Anything that isn't a tool event renders on its own. */
interface SingleItem {
  kind: "single";
  event: TurnEvent;
}
type TimelineItem = ToolGroup | SingleItem;

/** Partition events into groups: consecutive tool events merge into one group. */
function groupEvents(events: TurnEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let i = 0;
  let groupSeq = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type === "tool") {
      // Gather the contiguous run of tool events.
      const tools: ToolEvent[] = [];
      while (i < events.length && events[i].type === "tool") {
        tools.push(events[i] as ToolEvent);
        i++;
      }
      items.push({ kind: "tool-group", id: `tg_${groupSeq++}`, tools });
    } else {
      items.push({ kind: "single", event: ev });
      i++;
    }
  }
  return items;
}

export function TurnTimeline({
  events,
  isActive,
}: {
  events: TurnEvent[];
  /** Whether the turn is still streaming (drives per-event default expansion). */
  isActive?: boolean;
}) {
  if (events.length === 0) return null;
  const items = groupEvents(events);

  return (
    <div
      style={{
        position: "relative",
        // Left rail: a thin vertical line tying all events of this turn
        // together visually (Windsurf-style cascade).
        paddingLeft: 14,
        marginTop: 4,
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 4,
          top: 6,
          bottom: 6,
          width: 1,
          background: "var(--gray-200)",
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) =>
          item.kind === "tool-group" ? (
            <ToolGroupBar key={item.id} tools={item.tools} isActive={isActive} />
          ) : (
            <EventRow key={item.event.id} event={item.event} isActive={isActive} />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A collapsible summary bar for a group of consecutive tool calls (yuxi-style).
 *
 * Folded (always, by default): one line — a status icon + "已调用 N 个工具"
 * + de-duplicated tool-name tags + a tail status summary ("3 完成" /
 * "1 进行中 · 2 完成"). Clicking the arrow expands the individual
 * ToolCallRenderer cards beneath. The group never auto-expands — the user
 * opts in to seeing the per-tool detail — so a tool-heavy turn stays compact.
 *
 * Minimal visual treatment: no background or border, just the summary text,
 * matching the reasoning block's unobtrusive style.
 */
function ToolGroupBar({ tools }: { tools: ToolEvent[]; isActive?: boolean }) {
  // Always collapsed by default — user clicks to expand per-tool detail.
  const [expanded, setExpanded] = useState<boolean>(false);

  const total = tools.length;
  const done = tools.filter((t) => t.entry.status === "done").length;
  const errored = tools.filter((t) => t.entry.status === "error").length;
  const pending = total - done - errored;
  const allDone = pending === 0 && errored === 0 && done === total;

  // Status icon for the summary bar.
  let statusIcon;
  if (errored > 0) {
    statusIcon = <CloseCircleFilled style={{ color: "var(--color-error-500)" }} />;
  } else if (pending > 0) {
    statusIcon = <LoadingOutlined style={{ color: "var(--color-info-700)" }} />;
  } else if (allDone) {
    statusIcon = <CheckCircleFilled style={{ color: "var(--color-success-500)" }} />;
  } else {
    statusIcon = <ClockCircleOutlined style={{ color: "var(--gray-400)" }} />;
  }

  // De-duplicated tool names for the summary tags (max 3 visible).
  const uniqueNames = Array.from(new Set(tools.map((t) => t.entry.name)));
  const visibleNames = uniqueNames.slice(0, 3);
  const extraNames = uniqueNames.length - visibleNames.length;

  return (
    <Collapse
      ghost
      size="small"
      activeKey={expanded ? ["g"] : []}
      onChange={(keys) => setExpanded(keys.length > 0)}
      expandIcon={({ isActive: open }) => (
        <CaretRightOutlined rotate={open ? 90 : 0} style={{ fontSize: 12 }} />
      )}
      style={{ background: "transparent" }}
      items={[
        {
          key: "g",
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
                flexWrap: "wrap",
              }}
            >
              {statusIcon}
              <span>{total === 1 ? "已调用 1 个工具" : `已调用 ${total} 个工具`}</span>
              {visibleNames.map((n) => (
                <Tag
                  key={n}
                  style={{
                    margin: 0,
                    fontSize: 11,
                    lineHeight: "18px",
                    background: "transparent",
                    border: "1px solid var(--gray-200)",
                    color: "var(--gray-500)",
                  }}
                >
                  {n}
                </Tag>
              ))}
              {extraNames > 0 && (
                <span style={{ fontSize: 11, color: "var(--gray-400)" }}>+{extraNames}</span>
              )}
              <span style={{ marginLeft: "auto", fontSize: 11 }}>
                {buildStatusNode({ done, errored, pending })}
              </span>
            </div>
          ),
          children: (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 4 }}>
              {tools.map((t) => (
                <ToolCallRenderer key={t.id} entry={t.entry} defaultExpanded={false} />
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

function buildStatusNode({
  done,
  errored,
  pending,
}: {
  done: number;
  errored: number;
  pending: number;
}) {
  const parts: React.ReactNode[] = [];
  if (pending > 0) {
    parts.push(
      <span key="pend" style={{ color: "var(--color-info-700)" }}>
        {pending} 进行中
      </span>,
    );
  }
  if (done > 0) {
    parts.push(
      <span key="done" style={{ color: "var(--color-success-700)" }}>
        {done} 完成
      </span>,
    );
  }
  if (errored > 0) {
    parts.push(
      <span key="err" style={{ color: "var(--color-error-700)" }}>
        {errored} 失败
      </span>,
    );
  }
  if (parts.length === 0) {
    parts.push(
      <span key="idle" style={{ color: "var(--gray-400)" }}>
        等待
      </span>,
    );
  }
  return parts.flatMap((p, i) =>
    i === 0 ? [p] : [<span key={`sep${i}`} style={{ color: "var(--gray-300)" }}> · </span>, p],
  );
}
