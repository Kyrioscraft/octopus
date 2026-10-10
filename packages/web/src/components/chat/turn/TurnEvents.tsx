import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TurnEvent } from "./types.js";
import type { TurnItem } from "./project.js";
import { EventRow } from "./EventRow.js";
import { useDisplaySettingsStore } from "../../../stores/display.js";
import { projectTurnParts } from "./project.js";
import { ShimmerText } from "../ShimmerText.js";
import { Markdown } from "../../widgets/Markdown.js";
import { WorkTimer } from "../WorkTimer.js";

/**
 * Timing metadata for one assistant turn, passed down by MessageBubble so the
 * timer row can act as the WHOLE turn's collapse switch (see below).
 */
export interface TurnTimer {
  startedAtMs?: number;
  durationMs?: number;
  running: boolean;
}

/**
 * The ordered timeline of events for one assistant turn.
 *
 * Grouping/projection lives in project.ts (projectTurnParts — the pure derived
 * layer shared by live and history rendering); this file is the presentation
 * layer only.
 *
 * Structure: `buildBlocks` splits the events into ordered runs of
 *   - **process blocks** (reasoning / tool calls / subagents) — the work log,
 *     each headed by an 「已执行工具」 summary that collapses just that block;
 *   - **text blocks** — the answer, full width.
 *
 * The turn-level timer row (when `timer` is provided, i.e. on the main
 * timeline) is the GLOBAL switch: while streaming the log is open; once the
 * turn finishes (and `autoCollapseTrace` is on) everything folds under the
 * timer row and only the final answer text stays outside. Clicking the timer
 * row expands the whole process again. Nested lists without a `timer` (the
 * subagent side panel) render expanded with no switch.
 */
export function TurnEvents({
  events,
  isActive,
  onOpenSubagent,
  timer,
}: {
  events: TurnEvent[];
  /** Whether the turn is still streaming (drives per-event default expansion). */
  isActive?: boolean;
  /** Called when a subagent row is clicked — opens the side panel on it.
   *  Forwarded down to EventRow → SubagentRow. Optional because nested
   *  event lists (inside the side panel) don't need it. */
  onOpenSubagent?: (event: import("./types.js").SubagentEvent) => void;
  /** Turn timing — present on the main timeline, absent in nested panels. */
  timer?: TurnTimer;
}) {
  const showAllReasoning = useDisplaySettingsStore((s) => s.showFullReasoning);
  const autoCollapse = useDisplaySettingsStore((s) => s.autoCollapseTrace);
  // null → follow the turn's state; boolean → the user toggled the timer row.
  const [override, setOverride] = useState<boolean | null>(null);

  if (events.length === 0) return null;
  const items = projectTurnParts(events, { showAllReasoning });
  const blocks = buildBlocks(items);
  if (blocks.length === 0) return null;

  const hasTimer = !!timer;
  // Whole-turn collapse: only after the turn settles (a running turn always
  // shows its log), gated by the setting, with the manual toggle winning.
  const turnCollapsed = !!timer && !timer.running && autoCollapse && override !== true;

  // The answer the folded state keeps outside: the LAST text block.
  const lastText = [...blocks].reverse().find((b) => b.kind === "text");
  const failed = blocks.reduce((n, b) => (b.kind === "process" ? n + countFailures(b.items) : n), 0);
  const cancelled = blocks.reduce((n, b) => (b.kind === "process" ? n + countCancelled(b.items) : n), 0);

  return (
    <div
      style={{
        // Full column width: without this, the flex parent (MessageBubble's
        // align-items: flex-start) shrinks this container to its widest child,
        // and the timer row's divider would track the text content length.
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {hasTimer && (
        <WorkTimer
          startedAtMs={timer!.startedAtMs}
          durationMs={timer!.durationMs}
          running={timer!.running}
          expanded={!turnCollapsed}
          onToggle={() => setOverride(turnCollapsed)}
          failed={failed}
          cancelled={cancelled}
        />
      )}

      {turnCollapsed ? (
        // Folded: timer row + only the final answer text.
        lastText?.kind === "text" && <AnswerBlock text={lastText.text} />
      ) : (
        blocks.map((block) =>
          block.kind === "text" ? (
            <AnswerBlock key={block.id} text={block.text} />
          ) : (
            <ProcessBlock
              key={block.id}
              items={block.items}
              isActive={isActive}
              onOpenSubagent={onOpenSubagent}
            />
          ),
        )
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
 * The three block renderers
 * ------------------------------------------------------------------------- */

/** The answer: full width, no chrome. */
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
 * A run of process events (reasoning / tools / subagents), headed by a summary
 * that collapses just this block. The header tracks THIS block's own liveness:
 * 「正在执行工具」(shimmer) while any of its entries is in flight, flipping to
 * 「已执行工具」 when the last member settles — per block, not per turn. The
 * block stays expanded through that flip; folding the whole turn is the Timer
 * row's job. Entries render as plain rows — no rail, no status dots.
 */
function ProcessBlock({
  items,
  isActive,
  onOpenSubagent,
}: {
  items: TurnItem[];
  isActive?: boolean;
  onOpenSubagent?: (event: import("./types.js").SubagentEvent) => void;
}) {
  // Per-block running detection — drives the header shimmer/text. Collapse does
  // NOT follow the block's own completion; it follows the turn Timer (turnCollapsed).
  const running = blockHasRunning(items);
  // null → follow the derived state; boolean → the user toggled this block.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [wasRunning, setWasRunning] = useState<boolean>(running);
  // Streaming: the block mounts open so in-flight tools are directly visible,
  // and STAYS open — completing the tools only flips the header to
  // 「已执行工具」; folding is the Timer row's job (turnCollapsed).
  const [autoOpen, setAutoOpen] = useState<boolean>(running);

  useEffect(() => {
    if (running !== wasRunning) setWasRunning(running);
  }, [running, wasRunning]);

  const open = userOpen ?? autoOpen;
  const failed = countFailures(items);
  const cancelled = countCancelled(items);

  return (
    <div>
      <button
        type="button"
        className="focus-ring"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: 0,
          border: "none",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          cursor: "pointer",
          font: "inherit",
          fontSize: "var(--text-sm)",
          color: "var(--text-tertiary)",
          textAlign: "left",
          transition: "color var(--dur-1) var(--ease)",
        }}
      >
        <span style={{ display: "flex", fontSize: 14, color: "var(--text-disabled)", flexShrink: 0 }}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </span>
        {running ? (
          <ShimmerText text="正在执行工具" fontSize={14} fontWeight={500} />
        ) : (
          <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>已执行工具</span>
        )}
        {failed > 0 && (
          <span className="tnum" style={{ color: "var(--color-error-500)" }}>
            · {failed} 个失败
          </span>
        )}
        {cancelled > 0 && (
          <span className="tnum">· {cancelled} 个已取消</span>
        )}
      </button>

      {open && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            paddingTop: 4,
          }}
        >
          {/* Exploration groups are flattened: their member tools render as
              plain EventRows (grouping into a second collapsible layer made
              the disclosure too deep). */}
          {items.flatMap((item) =>
            item.kind === "tool-group"
              ? item.tools.map((t) => (
                  <EventRow
                    key={t.id}
                    event={t}
                    isActive={isActive}
                    onOpenSubagent={onOpenSubagent}
                  />
                ))
              : [
                  <EventRow
                    key={item.event.id}
                    event={item.event}
                    isActive={isActive}
                    onOpenSubagent={onOpenSubagent}
                  />,
                ],
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Summary counts
 * ------------------------------------------------------------------------- */

function countFailures(items: TurnItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "tool-group") n += item.tools.filter((t) => t.entry.status === "error").length;
    else if (item.event.type === "tool" && item.event.entry.status === "error") n += 1;
  }
  return n;
}

function countCancelled(items: TurnItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "tool-group") {
      n += item.tools.filter((t) => t.entry.status === "cancelled").length;
    } else if (item.event.type === "tool" && item.event.entry.status === "cancelled") {
      n += 1;
    } else if (item.event.type === "subagent" && item.event.status === "cancelled") {
      n += 1;
    }
  }
  return n;
}

/** Does this block still have an in-flight entry? Drives its header state. */
function blockHasRunning(items: TurnItem[]): boolean {
  for (const item of items) {
    if (item.kind === "tool-group") {
      if (item.tools.some((t) => t.entry.status !== "done" && t.entry.status !== "error" && t.entry.status !== "cancelled")) return true;
      continue;
    }
    const e = item.event;
    if (e.type === "tool" && e.entry.status !== "done" && e.entry.status !== "error" && e.entry.status !== "cancelled") return true;
    if (e.type === "subagent" && e.status === "streaming") return true;
    if (e.type === "reasoning" && e.endedAt === undefined) return true;
  }
  return false;
}
