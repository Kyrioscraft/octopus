import { useState } from "react";
import type { TurnEvent, ToolEvent } from "./types.js";
import type { TurnItem } from "./project.js";
import { EventRow } from "./EventRow.js";
import { ToolCallRenderer } from "../rows/tools/ToolCallRenderer.js";
import { useDisplaySettingsStore } from "../../../stores/display.js";
import { projectTurnParts } from "./project.js";
import { isSearchCall, isFileReadCall } from "../rows/tools/registry.js";
import { Collapse } from "antd";
import { ChevronDown, ChevronRight, CircleX, Search } from "lucide-react";
import { ShimmerText } from "../ShimmerText.js";
import { Markdown } from "../../widgets/Markdown.js";

/**
 * The ordered timeline of events for one assistant turn.
 *
 * Grouping/projection lives in project.ts (projectTurnParts — the pure derived
 * layer shared by live and history rendering); this file is the presentation
 * layer only.
 *
 * Presentation splits the turn into two kinds of blocks, in order:
 *   - **process** blocks (reasoning / tool calls / subagents) hang off a hairline
 *     vertical rail (`TraceBlock`) — the "work log";
 *   - **text** blocks are the answer, rendered full width with no rail.
 * Keeping them separate is what makes an agent turn readable at a glance: the log
 * is visibly secondary, the reply is not.
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
  const blocks = buildBlocks(items);

  return (
    <div
      style={{
        marginTop: 2,
        maxWidth: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {blocks.map((block) =>
        block.kind === "text" ? (
          <AnswerBlock key={block.id} text={block.text} />
        ) : (
          <TraceBlock
            key={block.id}
            items={block.items}
            isActive={isActive}
            onOpenSubagent={onOpenSubagent}
          />
        ),
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Block partitioning
 * ------------------------------------------------------------------------- */

type Block =
  | { kind: "process"; id: string; items: TurnItem[] }
  | { kind: "text"; id: string; text: string };

function itemId(item: TurnItem): string {
  return item.kind === "tool-group" ? item.id : item.event.id;
}

/** Split the projected items into ordered runs of process events and answer text. */
function buildBlocks(items: TurnItem[]): Block[] {
  const blocks: Block[] = [];
  let run: TurnItem[] = [];
  const flush = () => {
    if (run.length === 0) return;
    blocks.push({ kind: "process", id: `p:${itemId(run[0])}`, items: run });
    run = [];
  };
  for (const item of items) {
    // Only a standalone text event is an answer; everything else is process.
    if (item.kind === "single" && item.event.type === "text") {
      flush();
      blocks.push({ kind: "text", id: `t:${item.event.id}`, text: item.event.text });
    } else {
      run.push(item);
    }
  }
  flush();
  return blocks;
}

/* ---------------------------------------------------------------------------
 * The two block renderers
 * ------------------------------------------------------------------------- */

/** The answer: full width, no rail, no chrome. */
function AnswerBlock({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: "var(--text-md)",
        lineHeight: "26px",
        letterSpacing: "0.01em",
        color: "var(--text-primary)",
        wordBreak: "break-word",
      }}
    >
      <Markdown content={text} />
    </div>
  );
}

/**
 * A run of process events: folded it is one quiet line, expanded it is a railed
 * log.
 *
 * Disclosure: while the turn streams the log is open (that's the live feedback);
 * once it stops it folds to `已完成 · 5 步` unless the user has toggled this
 * particular block, which always wins. On history replay the block mounts already
 * finished, i.e. folded. Controlled by the `autoCollapseTrace` display setting.
 *
 * Geometry: the summary and every entry's text share the same 16px left inset, so
 * folding/unfolding doesn't shift the text, and the rail (drawn by `.trace-body`)
 * runs through the dots' column rather than out at the column edge. A folded block
 * has no rail at all — a short orphan line segment was what made the old trace
 * look broken.
 */
function TraceBlock({
  items,
  isActive,
  onOpenSubagent,
}: {
  items: TurnItem[];
  isActive?: boolean;
  onOpenSubagent?: (event: import("./types.js").SubagentEvent) => void;
}) {
  const autoCollapse = useDisplaySettingsStore((s) => s.autoCollapseTrace);
  // null → follow the turn's state; boolean → the user overrode it.
  const [override, setOverride] = useState<boolean | null>(null);

  const expanded = override ?? (isActive || !autoCollapse);

  const steps = countSteps(items);
  const failed = countFailures(items);

  return (
    <div className="trace-block">
      <button
        type="button"
        className="trace-summary focus-ring"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
      >
        <span className="chev">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        {isActive ? (
          <ShimmerText text="执行中" fontSize={12.5} fontWeight={500} />
        ) : (
          <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
            {failed > 0 ? "已结束" : "已完成"}
          </span>
        )}
        <span style={{ color: "var(--text-disabled)" }}>·</span>
        <span className="tnum">{steps} 步</span>
        {failed > 0 && (
          <>
            <span style={{ color: "var(--text-disabled)" }}>·</span>
            <span className="tnum" style={{ color: "var(--color-error-500)" }}>
              {failed} 个失败
            </span>
          </>
        )}
      </button>

      {expanded && (
        <div className="trace-body">
          {items.map((item) => (
            <TraceEntry key={itemId(item)} item={item} isActive={isActive} onOpenSubagent={onOpenSubagent} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One rail entry: the status dot in the gutter, then the row itself. */
function TraceEntry({
  item,
  isActive,
  onOpenSubagent,
}: {
  item: TurnItem;
  isActive?: boolean;
  onOpenSubagent?: (event: import("./types.js").SubagentEvent) => void;
}) {
  if (item.kind === "tool-group") {
    return (
      <div className="trace-entry">
        <span
          className={`trace-dot${
            item.tools.some((t) => t.entry.status === "error")
              ? " is-error"
              : item.tools.some((t) => t.entry.status !== "done" && t.entry.status !== "error")
                ? " is-running"
                : ""
          }`}
        />
        <div className="trace-entry-body">
          <ToolGroupBar tools={item.tools} />
        </div>
      </div>
    );
  }

  const event = item.event;
  if (event.type === "text") return null;

  const dotClass =
    event.type === "tool"
      ? event.entry.status === "error"
        ? " is-error"
        : event.entry.status !== "done"
          ? " is-running"
          : ""
      : event.type === "reasoning" && isActive
        ? " is-running"
        : "";

  return (
    <div className="trace-entry">
      <span className={`trace-dot${dotClass}`} />
      <div className="trace-entry-body">
        <EventRow event={event} isActive={isActive} onOpenSubagent={onOpenSubagent} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Summary counts
 * ------------------------------------------------------------------------- */

function countSteps(items: TurnItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "tool-group") n += item.tools.length;
    else {
      const t = item.event.type;
      if (t === "tool" || t === "reasoning" || t === "subagent") n += 1;
    }
  }
  return n;
}

function countFailures(items: TurnItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "tool-group") n += item.tools.filter((t) => t.entry.status === "error").length;
    else if (item.event.type === "tool" && item.event.entry.status === "error") n += 1;
  }
  return n;
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
 * Folded (default): a single tool-row-style line — status icon + "探索" label
 * (ShimmerText while any member is in flight) + counts. No Loader spinner: the
 * running state lives in the shimmer, same as tool rows.
 *
 * Expanded: the member calls as standard tool rows, each collapsed by default.
 * The group's own indentation comes from the surrounding rail.
 */
export function ToolGroupBar({ tools }: { tools: ToolEvent[] }) {
  // Always collapsed by default — user clicks to expand.
  const [expanded, setExpanded] = useState<boolean>(false);

  const done = tools.filter((t) => t.entry.status === "done").length;
  const errored = tools.filter((t) => t.entry.status === "error").length;
  const pending = tools.length - done - errored;

  const leadIcon =
    errored > 0 ? (
      <CircleX style={{ color: "var(--color-error-500)" }} />
    ) : (
      <Search style={{ fontSize: 13, color: "var(--text-tertiary)" }} />
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
                  // Same type treatment as ToolCallRow's header, so "探索" and a
                  // tool row's display name read as the same kind of thing.
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center" }}>{leadIcon}</span>
                {pending > 0 ? <ShimmerText text="探索" fontSize={12.5} /> : <span>探索</span>}
                <span style={{ color: "var(--text-disabled)" }}>·</span>
                <span
                  style={{
                    color: "var(--text-secondary)",
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
                  gap: 4,
                  paddingLeft: 10,
                  paddingTop: 2,
                  paddingBottom: 4,
                  borderLeft: "1px solid var(--border-subtle)",
                  marginLeft: 4,
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