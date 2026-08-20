import { useState } from "react";
import type { TurnEvent, ToolEvent } from "./types.js";
import { EventRow } from "./EventRow.js";
import { ToolCallRenderer } from "../rows/tools/ToolCallRenderer.js";
import { useDisplaySettingsStore } from "../../../stores/display.js";
import { projectTurnParts } from "./project.js";
import type { TurnItem } from "./project.js";
import { ShimmerText } from "../ShimmerText.js";
import {
  isExplorationCall,
  isFileReadCall,
  isSearchCall,
} from "../rows/tools/registry.js";
import { Collapse } from "antd";
import {
  CircleX,
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
 * Lead text for an exploration group's folded summary: counts BOTH kinds —
 * "搜索了 X 项 · 读取了 Y 个文件" (X = search-class tools incl. ls/rg/grep
 * family, Y = read_file). Zero-count halves are omitted. Degenerate group
 * (neither) → "探索了目录".
 */
function explorationLeadText(tools: ToolEvent[]): string {
  const reads = tools.filter((t) => isFileReadCall(t.entry)).length;
  const searches = tools.filter((t) => isSearchCall(t.entry)).length;
  const parts: string[] = [];
  if (searches > 0) parts.push(searches === 1 ? "搜索了 1 项" : `搜索了 ${searches} 项`);
  if (reads > 0) parts.push(reads === 1 ? "读取了 1 个文件" : `读取了 ${reads} 个文件`);
  return parts.length > 0 ? parts.join(" · ") : "探索了目录";
}

/**
 * A collapsible summary bar for a contiguous run of exploration tool calls.
 *
 * Folded (default): one line — a status icon + the group label. The icon
 * follows the TOOL-ROW convention (ToolCallRow.RowIcon): the Search type icon
 * (dimmed when settled, normal while running — no spinner) and CircleX on
 * error. While any tool is still in flight the "探索" label runs the same
 * ShimmerText wave-flash animation as a running tool row's name; once done it
 * settles into the counts ("搜索了 X 项 · 读取了 Y 个文件").
 * Expanded: every exploration tool rendered as its own standard tool row
 * (read_file → FileReadRow; searches → DefaultRow skeleton), in original
 * event order — identical components to the non-grouped timeline rows.
 *
 * Minimal visual treatment: no background or border, just the summary text,
 * matching the reasoning block's unobtrusive style.
 */
export function ToolGroupBar({ tools, isActive }: { tools: ToolEvent[]; isActive?: boolean }) {
  // Always collapsed by default — user clicks to expand.
  const [expanded, setExpanded] = useState<boolean>(false);

  // All grouped tools render as rows (call-level filter — a shell search
  // command is part of the group too) and count toward status.
  const displayed = tools.filter((t) => isExplorationCall(t.entry));

  const total = displayed.length;
  const done = displayed.filter((t) => t.entry.status === "done").length;
  const errored = displayed.filter((t) => t.entry.status === "error").length;
  const pending = total - done - errored;

  // Single-slot icon, same semantics as a tool row (no spinner — the running
  // state is signalled by the shimmer label below).
  const leadIcon =
    errored > 0 ? (
      <CircleX style={{ color: "var(--color-error-500)" }} />
    ) : (
      <span style={{ display: "inline-flex", alignItems: "center", color: "var(--gray-400)" }}>
        <Search style={{ fontSize: 13 }} />
      </span>
    );

  const leadText = explorationLeadText(tools);

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
              {pending > 0 ? (
                <>
                  {/* Same wave-flash animation as a running tool row's name. */}
                  <ShimmerText text="探索" />
                  <span>{leadText}</span>
                </>
              ) : (
                <span>{leadText}</span>
              )}
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
 * Expanded view of an exploration group: the tools rendered as STANDARD tool
 * rows in their original event order — read_file as FileReadRow, searches
 * (grep/glob/search_file_content/grep_search/rg/find) and directory listings
 * (ls/list_directory) as the DefaultRow skeleton. Same components as the
 * non-grouped timeline (EventRow's tool branch), so an expanded group looks
 * exactly like the calls would have looked ungrouped.
 */
export function ExplorationCluster({
  tools,
  isActive,
}: {
  tools: ToolEvent[];
  isActive?: boolean;
}) {
  if (tools.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 }}>
      {tools.map((t) => (
        <ToolCallRenderer key={t.id} entry={t.entry} defaultExpanded={isActive} />
      ))}
    </div>
  );
}
