import { useState } from "react";
import type { TurnEvent, ToolEvent } from "./types.js";
import { EventRow } from "./EventRow.js";
import { ToolCallRenderer } from "../rows/tools/ToolCallRenderer.js";
import { useDisplaySettingsStore } from "../../../stores/display.js";
import { projectTurnParts } from "./project.js";
import type { TurnItem } from "./project.js";
import {
  isDisplayedExplorationTool,
  isFileReadTool,
  readonlyToolTarget,
  getToolDisplayName,
} from "../rows/tools/registry.js";
import { Collapse, Tooltip } from "antd";
import {
  CircleX,
  Loader,
  Search,
} from "lucide-react";

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
            <ToolGroupBar key={item.id} tools={item.tools} isActive={isActive} />
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
 * Lead text for an exploration group's folded summary.
 *
 * Prefers "探索了 N 个文件" (N = read_file count) when there are file reads;
 * falls back to "搜索了 M 项" (M = grep/glob/search_file_content count) when
 * the group is purely search-based. list_directory/ls never counts.
 */
function explorationLeadText(tools: ToolEvent[]): string {
  const reads = tools.filter((t) => isFileReadTool(t.entry.name)).length;
  const searches = tools.filter((t) =>
    ["glob", "grep", "search_file_content"].includes(t.entry.name),
  ).length;
  if (reads > 0) {
    return reads === 1 ? "探索了 1 个文件" : `探索了 ${reads} 个文件`;
  }
  if (searches > 0) {
    return searches === 1 ? "搜索了 1 项" : `搜索了 ${searches} 项`;
  }
  // Group has only list_directory/ls (all hidden) — still show a neutral label.
  return "探索了目录";
}

/**
 * A collapsible summary bar for a contiguous run of exploration tool calls.
 *
 * Folded (default): one line — a status icon + lead text ("探索了 N 个文件" /
 * "搜索了 M 项") + file-name/search-term chips (max 3, +M) + a tail status.
 * Expanded: an ExplorationCluster — a chips list (read_file → file name,
 * grep/glob → search term; list_directory/ls hidden), each chip carrying a
 * status dot; clicking a chip opens that single tool's full content inline.
 *
 * Minimal visual treatment: no background or border, just the summary text,
 * matching the reasoning block's unobtrusive style.
 */
export function ToolGroupBar({ tools, isActive }: { tools: ToolEvent[]; isActive?: boolean }) {
  // Always collapsed by default — user clicks to expand.
  const [expanded, setExpanded] = useState<boolean>(false);

  // Only the displayed exploration tools count toward status / chips.
  const displayed = tools.filter((t) => isDisplayedExplorationTool(t.entry.name));

  const total = displayed.length;
  const done = displayed.filter((t) => t.entry.status === "done").length;
  const errored = displayed.filter((t) => t.entry.status === "error").length;
  const pending = total - done - errored;
  const allDone = pending === 0 && errored === 0 && done === total;

  // Single-slot icon: spinner while any tool is still in flight, the
  // exploration-group (Search) type icon once all done (dimmed), error icon
  // otherwise — mirrors ToolCallRow / SubagentRow.
  let leadIcon;
  if (errored > 0) {
    leadIcon = <CircleX style={{ color: "var(--color-error-500)" }} />;
  } else if (pending > 0) {
    leadIcon = <Loader size={14} style={{ color: "var(--gray-400)", animation: "spin 0.8s linear infinite" }} />;
  } else if (allDone) {
    leadIcon = <Search style={{ fontSize: 13, color: "var(--gray-400)" }} />;
  } else {
    leadIcon = <Loader size={14} style={{ color: "var(--gray-400)", animation: "spin 0.8s linear infinite" }} />;
  }

  // Folded chips: up to 3 targets (file name / search term), remainder "+M".
  const targets = displayed.map((t) => ({
    id: t.id,
    label: readonlyToolTarget(t.entry.name, t.entry.args) || getToolDisplayName(t.entry.name),
  }));
  const visibleTargets = targets.slice(0, 3);
  const extra = targets.length - visibleTargets.length;

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
              {leadIcon}
              <span>{explorationLeadText(tools)}</span>
              {visibleTargets.map((t) => (
                <span
                  key={t.id}
                  style={{
                    fontSize: 11,
                    lineHeight: "18px",
                    background: "transparent",
                    border: "1px solid var(--gray-200)",
                    color: "var(--gray-500)",
                    padding: "0 6px",
                    borderRadius: 4,
                    maxWidth: 180,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.label}
                </span>
              ))}
              {extra > 0 && <span style={{ fontSize: 11, color: "var(--gray-400)" }}>+{extra}</span>}
            </div>
          ),
          children: <ExplorationCluster tools={displayed} isActive={isActive} />,
        },
      ]}
    />
    </div>
  );
}

/**
 * A compact cluster view for a group of exploration tools (read_file / glob /
 * grep / search_file_content). list_directory/ls is already filtered out by
 * the caller.
 *
 * Folded: hidden behind the parent ToolGroupBar summary.
 * Expanded (rendered as the group's children): a chips list — one chip per
 * exploration tool (read_file → file name, grep/glob → search term), each
 * carrying a colored status dot (done=green, pending=blue, error=red).
 * Clicking a chip opens that single tool's full content inline — never all at
 * once — so N parallel reads/searches don't stack into N×420px of blocks.
 *
 * This is the Cursor/Windsurf-style demotion of exploratory tools: reads and
 * searches should not command the same screen real estate as writes.
 */
export function ExplorationCluster({
  tools,
  isActive,
}: {
  tools: ToolEvent[];
  isActive?: boolean;
}) {
  // The single tool whose full content is shown inline (null = none selected).
  const [activeId, setActiveId] = useState<string | null>(null);

  if (tools.length === 0) return null;
  const activeTool = tools.find((t) => t.id === activeId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 4 }}>
      {/* Chips: one per displayed exploration tool. Click a chip to open its content. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 21 }}>
        {tools.map((t) => {
          const label =
            readonlyToolTarget(t.entry.name, t.entry.args) ||
            getToolDisplayName(t.entry.name);
          const st = t.entry.status;
          const dotColor =
            st === "error"
              ? "var(--color-error-500)"
              : st === "done"
                ? "var(--color-success-500)"
                : "var(--color-info-700)";
          const selected = activeId === t.id;
          return (
            <Tooltip
              key={t.id}
              title={getToolDisplayName(t.entry.name)}
              mouseEnterDelay={0.4}
            >
              <button
                type="button"
                onClick={() => setActiveId(selected ? null : t.id)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11,
                  lineHeight: "20px",
                  padding: "0 8px",
                  borderRadius: 4,
                  border: selected
                    ? "1px solid var(--brand-500, #1677ff)"
                    : "1px solid var(--gray-200)",
                  background: selected ? "var(--brand-50, #eff6ff)" : "transparent",
                  color: selected ? "var(--brand-600, #0958d9)" : "var(--gray-600)",
                  maxWidth: 220,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* Inline detail for the selected chip only — never all at once. */}
      {activeTool && (
        <div style={{ paddingLeft: 21, paddingTop: 2 }}>
          <ToolCallRenderer entry={activeTool.entry} defaultExpanded={true} />
        </div>
      )}
    </div>
  );
}
