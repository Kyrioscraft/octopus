import { useState } from "react";
import type { TurnEvent, ToolEvent } from "./types.js";
import { EventRow } from "./EventRow.js";
import { ToolCallRenderer } from "../rows/tools/ToolCallRenderer.js";
import { useDisplaySettingsStore } from "../../../stores/display.js";
import { projectTurnParts } from "./project.js";
import type { TurnItem } from "./project.js";
import { isSearchCall, isFileReadCall } from "../rows/tools/registry.js";
import { Collapse } from "antd";
import { CircleX, Search } from "lucide-react";
import { ShimmerText } from "../ShimmerText.js";

/**
 * The ordered timeline of events for one assistant turn.
 *
 * Grouping/projection lives in project.ts (projectTurnParts — the pure
 * derived layer shared by live and history rendering); this file is the
 * presentation layer only.
 */

export function TurnEvents({
  events,
  isActive,
  onOpenSubagent,
}: {
  events: TurnEvent[];
  /** Whether the turn is still streaming (drives per-event default expansion). */
  isActive?: boolean;
  /** Called when a subagent row is clicked — opens the side panel on it.
   *  Forwarded down to EventRow → SubagentRow. Optional because nested
   *  event lists (inside the side panel) don't need it. */
  onOpenSubagent?: (event: import("./types.js").SubagentEvent) => void;
}) {
  const showAllReasoning = useDisplaySettingsStore((s) => s.showFullReasoning);
  if (events.length === 0) return null;
  const items = projectTurnParts(events, { showAllReasoning });

  return (
    <div
      style={{
        marginTop: 4,
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) =>
          item.kind === "tool-group" ? (
            <ToolGroupBar key={item.id} tools={item.tools} />
          ) : (
            <EventRow
              key={item.event.id}
              event={item.event}
              isActive={isActive}
              onOpenSubagent={onOpenSubagent}
            />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * 折叠态计数文案:"搜索了 X 项 · 读取了 Y 个文件"(为零的一半省略;
 * 双零时组内只有目录列举等 → "探索了目录")。
 */
function explorationSummary(tools: ToolEvent[]): string {
  const searches = tools.filter((t) => isSearchCall(t.entry)).length;
  const reads = tools.filter((t) => isFileReadCall(t.entry)).length;
  const parts: string[] = [];
  if (searches > 0) parts.push(searches === 1 ? "搜索了 1 项" : `搜索了 ${searches} 项`);
  if (reads > 0) parts.push(reads === 1 ? "读取了 1 个文件" : `读取了 ${reads} 个文件`);
  return parts.length > 0 ? parts.join(" · ") : "探索了目录";
}

/**
 * A collapsible group row for a contiguous run of exploration calls.
 *
 * Folded (default): a single tool-row-style line, mirroring BashRow's header
 * structure — status icon + "探索" label (ShimmerText while any member is
 * still in flight, matching the running tool rows) + "|" + search/read counts.
 * No Loader spinner: the running state lives in the shimmer, same as tool rows.
 *
 * Expanded: a nested container (indent + left rail) listing every member call
 * as a standard tool row (FileReadRow / BashRow / DefaultRow via
 * ToolCallRenderer), each collapsed by default — the user opens rows
 * individually. The indent + rail make the group visually distinct from the
 * timeline's own rows.
 */
export function ToolGroupBar({ tools }: { tools: ToolEvent[] }) {
  // Always collapsed by default — user clicks to expand.
  const [expanded, setExpanded] = useState<boolean>(false);

  const done = tools.filter((t) => t.entry.status === "done").length;
  const errored = tools.filter((t) => t.entry.status === "error").length;
  const pending = tools.length - done - errored;

  // Single-slot icon with the tool-row semantics: error → red CircleX;
  // otherwise always the Search type icon in gray-400 (running is signalled by
  // the "探索" shimmer, never a spinner).
  const leadIcon =
    errored > 0 ? (
      <CircleX style={{ color: "var(--color-error-500)" }} />
    ) : (
      <Search style={{ fontSize: 13, color: "var(--gray-400)" }} />
    );

  return (
    <div className={`collapsible-row${expanded ? " is-expanded" : ""}`}>
      <Collapse
        ghost
        size="small"
        activeKey={expanded ? ["g"] : []}
        onChange={(keys) => setExpanded(keys.length > 0)}
        expandIconPosition="end"
        style={{ background: "transparent" }}
        items={[
          {
            key: "g",
            label: (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                  // 与 ToolCallRow 的 headerNode 同款排版(字号/字重/字距),
                  // 保证"探索"与工具 row 的显示名观感一致。
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--gray-500)",
                  letterSpacing: "0.025em",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center" }}>
                  {leadIcon}
                </span>
                {pending > 0 ? (
                  <ShimmerText text="探索" />
                ) : (
                  <span style={{ color: "var(--gray-500)" }}>探索</span>
                )}
                <span style={{ color: "var(--gray-400)" }}>|</span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--gray-900)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {explorationSummary(tools)}
                </span>
              </span>
            ),
            children: (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginLeft: 5,
                  paddingLeft: 10,
                  paddingTop: 2,
                  borderLeft: "2px solid var(--gray-150)",
                }}
              >
                {tools.map((t) => (
                  <ToolCallRenderer key={t.id} entry={t.entry} />
                ))}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
