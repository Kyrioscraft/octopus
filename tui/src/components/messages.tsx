// =============================================================================
// Message rendering components — user, assistant, tool, error, app, etc.
// Equivalent to Python tui.widgets.messages.
//
// Each message type is a React component rendered via Ink <Box>/<Text>.
// Ink 5 does not support click handlers on Text; expand/collapse is
// controlled via keyboard interactions at the parent level.
// =============================================================================

import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Box, Text, measureElement, useStdout } from "ink";
import type { DOMElement } from "ink";
import type { ChatMessageData, ToolStatus } from "../types.js";
import { getGlyphs } from "../config-ui.js";
import { ExploreWidget } from "./explore-widget.js";

// =============================================================================
// Props
// =============================================================================

export interface MessageProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

// =============================================================================
// Dispatcher — renders the appropriate component based on message role.
// Wrapped in React.memo so only the message whose props changed re-renders
// (critical for streaming — without this every token causes the entire
// message list to re-render, which flickers the terminal).
// =============================================================================

const MessageImpl: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  switch (message.role) {
    case "user":
      return <UserMessageView message={message} showTimestamps={showTimestamps} />;
    case "assistant":
      return <AssistantMessageView message={message} showTimestamps={showTimestamps} />;
    case "tool":
      return <ToolCallMessageView message={message} showTimestamps={showTimestamps} />;
    case "error":
      return <ErrorMessageView message={message} showTimestamps={showTimestamps} />;
    case "app":
      return <AppMessageView message={message} showTimestamps={showTimestamps} />;
    case "skill":
      return <SkillMessageView message={message} showTimestamps={showTimestamps} />;
    case "summarization":
      return <SummarizationMessageView message={message} showTimestamps={showTimestamps} />;
    case "diff":
      return <DiffMessageView message={message} showTimestamps={showTimestamps} />;
    case "subagent":
      return <ExploreWidget message={message} showTimestamps={showTimestamps} />;
    default:
      return (
        <Box flexDirection="row" paddingX={1}>
          <Text>{message.content}</Text>
        </Box>
      );
  }
};

export const Message = React.memo(MessageImpl);

// =============================================================================
// User message
// =============================================================================

const UserMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color="green" bold>
          {glyphs.arrow} You
        </Text>
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>
      <Box paddingLeft={2}>
        <Text>{message.content}</Text>
      </Box>
    </Box>
  );
};

// =============================================================================
// Assistant message (with optional reasoning)
// =============================================================================

const AssistantMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const reasoning = message.metadata?.reasoning as string | undefined;
  const isFinalized = message.metadata?.finalized === true;
  const isStreaming = !isFinalized && message.content.length > 0;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color="cyan" bold>
          {glyphs.bullet} Agent
        </Text>
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
        {isStreaming && (
          <Text color="yellow"> {glyphs.spinnerFrames[0]}</Text>
        )}
      </Box>

      {/* Reasoning section (shown if present) */}
      {reasoning && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>{"▶"} Thinking...</Text>
          <Box paddingLeft={2} marginTop={0}>
            <Text dimColor>{reasoning}</Text>
          </Box>
        </Box>
      )}

      {/* Main content */}
      <Box paddingLeft={2}>
        <Text>{message.content}</Text>
      </Box>
    </Box>
  );
};

// =============================================================================
// Tool call message
// =============================================================================

const FILE_EDIT_TOOLS = new Set(["write_file", "write", "edit_file", "edit"]);

function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.toLowerCase());
}

const ToolCallMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const { stdout } = useStdout();
  // Column-aware truncation: tool args are indented paddingLeft={4} plus the
  // "key: " prefix, so reserve ~10 cols of margin. Falls back to 80 if the
  // stdout width is unknown (non-TTY).
  const cols = stdout?.columns ?? 80;
  const argTruncate = Math.max(20, cols - 10);
  const toolName = (message.metadata?.toolName as string) ?? "tool";
  const toolStatus = (message.metadata?.toolStatus as ToolStatus) ?? "success";
  const toolArgs = message.metadata?.toolArgs as Record<string, unknown> | undefined;

  // File-edit tools get a compact diff-oriented rendering.
  if (isFileEditTool(toolName)) {
    return <FileEditToolView message={message} showTimestamps={showTimestamps} />;
  }

  // Status indicators
  const statusIcon = toolStatus === "running"
    ? glyphs.spinnerFrames[0]
    : toolStatus === "error" || toolStatus === "rejected"
    ? glyphs.cross
    : glyphs.checkmark;

  const statusColor = toolStatus === "running"
    ? "yellow"
    : toolStatus === "error" || toolStatus === "rejected"
    ? "red"
    : toolStatus === "awaiting_approval"
    ? "yellow"
    : "green";

  // Truncate long content to 8 lines
  const content = message.content || "";
  const lines = content.split("\n");
  const truncated = lines.length > 8
    ? lines.slice(0, 8).join("\n") + `\n${glyphs.ellipsis} (${lines.length} lines total)`
    : content;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color={statusColor}>
          {statusIcon} {glyphs.toolPrefix}
        </Text>
        <Text color="yellow" bold> {toolName}</Text>
        <Text dimColor> {toolStatus}</Text>
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>

      {/* Tool arguments */}
      {toolArgs && Object.keys(toolArgs).length > 0 && (
        <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
          {Object.entries(toolArgs).slice(0, 5).map(([key, value]) => (
            <Box key={key}>
              <Text dimColor>
                {key}: {typeof value === "string" && value.length > argTruncate
                  ? value.slice(0, argTruncate) + glyphs.ellipsis
                  : JSON.stringify(value)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Tool output */}
      {truncated && (
        <Box paddingLeft={4}>
          <Text dimColor>{truncated}</Text>
        </Box>
      )}
    </Box>
  );
};

// =============================================================================
// File-edit tool view — compact diff rendering
//
// ✓ edit_file  src/foo.ts  +5 -2
//   - oldLine
//   + newLine
// =============================================================================

const MAX_DIFF_LINES = 15;

const FileEditToolView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const toolName = (message.metadata?.toolName as string) ?? "edit_file";
  const toolStatus = (message.metadata?.toolStatus as string) ?? "done";
  const toolArgs = (message.metadata?.toolArgs ?? {}) as Record<string, unknown>;
  const diffStats = message.metadata?.diffStats as { added: number; removed: number } | undefined;

  const filePath = (toolArgs.file_path ?? toolArgs.path ?? "") as string;

  const isRunning = toolStatus === "running";
  const icon = isRunning ? glyphs.spinnerFrames[0] : glyphs.checkmark;
  const iconColor = isRunning ? "yellow" : "green";

  // Build diff lines for display.
  const diffLines = buildDiffLines(toolName, toolArgs);
  const shown = diffLines.slice(0, MAX_DIFF_LINES);
  const truncated = diffLines.length > MAX_DIFF_LINES;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {/* Summary line */}
      <Box flexDirection="row">
        <Text color={iconColor}>{icon} </Text>
        <Text bold color="yellow">{toolName}</Text>
        {filePath && <Text> {filePath}</Text>}
        {diffStats && (
          <Text>
            {" "}
            <Text color="green">+{diffStats.added}</Text>
            {" "}
            <Text color="red">-{diffStats.removed}</Text>
          </Text>
        )}
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>

      {/* Diff content (truncated) */}
      {shown.length > 0 && (
        <Box flexDirection="column" paddingLeft={4}>
          {shown.map((line, i) => (
            <Text key={i} color={line.color}>{line.text}</Text>
          ))}
          {truncated && (
            <Text dimColor>{glyphs.ellipsis} {diffLines.length - MAX_DIFF_LINES} more lines</Text>
          )}
        </Box>
      )}
    </Box>
  );
};

interface DiffLine {
  text: string;
  color: "red" | "green" | undefined;
}

/** Build line-by-line diff display from tool args. */
function buildDiffLines(toolName: string, args: Record<string, unknown>): DiffLine[] {
  const name = toolName.toLowerCase();
  const lines: DiffLine[] = [];

  if (name === "edit_file" || name === "edit") {
    const oldText = (args.old_text ?? args.old_string ?? "") as string;
    const newText = (args.new_text ?? args.new_string ?? "") as string;
    for (const line of (oldText ? oldText.split("\n") : [])) {
      lines.push({ text: `- ${line}`, color: "red" });
    }
    for (const line of (newText ? newText.split("\n") : [])) {
      lines.push({ text: `+ ${line}`, color: "green" });
    }
  } else if (name === "write_file" || name === "write") {
    const content = (args.content ?? "") as string;
    for (const line of (content ? content.split("\n") : [])) {
      lines.push({ text: `+ ${line}`, color: "green" });
    }
  }

  return lines;
};

// =============================================================================
// Error message
// =============================================================================

const ErrorMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color="red" bold>
          {glyphs.cross} Error
        </Text>
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>
      <Box paddingLeft={2}>
        <Text color="red">{message.content}</Text>
      </Box>
    </Box>
  );
};

// =============================================================================
// App / system message
// =============================================================================

const AppMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <Box flexDirection="row" paddingX={1} marginBottom={1}>
      <Text dimColor italic>
        {message.content}
      </Text>
      {showTimestamps && (
        <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
      )}
    </Box>
  );
};

// =============================================================================
// Skill invocation message
// =============================================================================

const SkillMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const skillName = (message.metadata?.skillName as string) ?? "skill";

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color="magenta" bold>
          {glyphs.toolPrefix} Skill: {skillName}
        </Text>
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>
      <Box paddingLeft={4}>
        <Text>{message.content}</Text>
      </Box>
    </Box>
  );
};

// =============================================================================
// Summarization notification
// =============================================================================

const SummarizationMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <Box flexDirection="row" paddingX={1} marginBottom={1}>
      <Text color="blue" bold>
        Summary
      </Text>
      <Text color="blue"> {message.content}</Text>
      {showTimestamps && (
        <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
      )}
    </Box>
  );
};

// =============================================================================
// Diff message
// =============================================================================

const DiffMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const lines = message.content.split("\n");

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text bold>Diff</Text>
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>
      {lines.slice(0, 30).map((line, i) => {
        const color = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
        return (
          <Box key={i} paddingLeft={2}>
            <Text color={color}>{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
};

// =============================================================================
// Message list container
//
// With alternate screen enabled, ALL messages live in a single virtual-scroll
// container.  The container is height-constrained (flexGrow from the parent)
// and only a sliding window of messages is rendered.  A scrollbar on the right
// edge shows the user's position.  Scroll is driven by keyboard (PageUp/Down,
// Ctrl+U/D) and mouse wheel events, both routed through the `scrollCommand` prop.
//
// When `maxHeight` is not provided (startup error screen), all messages are
// rendered without virtual scrolling — the parent layout already constrains
// the visible area.
// =============================================================================

export interface MessageListProps {
  messages: ChatMessageData[];
  showTimestamps?: boolean;
  /** Available rows for the message region, measured via yoga (useBoxMetrics).
   *  Replaces the old `maxHeight` (which came from a `rows - 6` magic constant). */
  viewportHeight?: number;
  /** Terminal column count (from useWindowSize) for column-aware truncation. */
  columns?: number;
  /**
   * Scroll command from the parent. Each input event emits a fresh object with
   * a unique `id` and a signed row delta already sized to the device (mouse
   * wheel = small, PageUp/Down = half page, arrows = 1). The effect below keys
   * on `id` so every event applies exactly once. Positive delta scrolls UP
   * (toward older messages, increases scrollOffset); negative scrolls DOWN.
   */
  scrollCommand?: { id: number; deltaRows: number };
}

// Content left-padding used by the message views (paddingLeft={2} inside a
// paddingX={1} Box → 3 columns of indent). Lines wrap at (columns - indent).
const CONTENT_INDENT = 3;

/**
 * Display width of a single Unicode code point in a monospace terminal.
 * Returns 2 for East-Asian Wide / Fullwidth / emoji-range glyphs, 1 otherwise.
 * This is a pragmatic subset of wcwidth — enough to stop the row estimator
 * from under-counting CJK text (the common case in this app), which previously
 * made totalRows far smaller than reality and maxScroll ≈ 0, so scrolling
 * stalled after a tiny movement even though lots of content was off-screen.
 */
function charWidth(code: number): number {
  if (code < 0x80) return 1; // ASCII fast path
  if (code === 0x0) return 0;
  // Combining marks (zero width) — simplified range check.
  if (code >= 0x300 && code <= 0x36f) return 0;
  // East Asian Wide / Fullwidth ranges (CJK, Kana, Hangul, CJK punctuation).
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string, accounting for wide (CJK/emoji) characters. */
function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * How many terminal rows a single text block occupies when rendered at the
 * given column count, accounting for terminal wrapping. A logical line whose
 * display width exceeds the available columns wraps across multiple rows.
 * Empty content counts as 1 row (a blank line) so the estimate never goes to 0.
 */
function wrappedRowCount(text: string, columns: number, indent = 0): number {
  const text_ = text ?? "";
  if (text_ === "") return 1;
  const avail = Math.max(1, columns - indent);
  let rows = 0;
  for (const line of text_.split("\n")) {
    const w = stringWidth(line);
    rows += Math.max(1, Math.ceil(w / avail));
  }
  return rows;
}

/**
 * Estimate how many terminal rows a message occupies, accounting for terminal
 * wrapping AND wide (CJK) glyphs. This is the STABLE heuristic used by
 * computeVisibleRange / totalRows / maxScroll — so it MUST be close to the real
 * rendered height, otherwise the scroll window geometry is wrong.
 *
 * Why column-awareness matters: the old version counted only `\n` splits,
 * treating a 400-char Chinese paragraph as "1 line". In an 80-column terminal
 * that actually wraps to ~10 rows. The under-estimate made `totalRows` tiny and
 * `maxScroll = totalRows - viewport` ≈ 0, so the user could "only scroll a
 * little" before hitting the clamp — exactly the reported symptom.
 *
 * `columns` comes from the terminal via useStdout (app.tsx passes it down).
 * Messages already measured by yoga (rowsOf) still take precedence in geometry
 * where the cache is consulted; this function just makes the fallback sane.
 */
function estimateMessageRows(msg: ChatMessageData, columns: number): number {
  const cols = columns > 0 ? columns : 80;
  switch (msg.role) {
    case "tool":
      return 2 + wrappedRowCount(msg.content, cols, CONTENT_INDENT);
    case "user":
      return 3 + wrappedRowCount(msg.content, cols, CONTENT_INDENT);
    case "assistant": {
      const reasoning = msg.metadata?.reasoning as string | undefined;
      const reasoningRows = reasoning
        ? 1 + wrappedRowCount(reasoning, cols, CONTENT_INDENT + 2)
        : 0;
      const contentRows = wrappedRowCount(msg.content, cols, CONTENT_INDENT);
      return 2 + reasoningRows + contentRows;
    }
    case "subagent":
      return 6;
    default:
      return 3;
  }
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  showTimestamps,
  viewportHeight,
  columns,
  scrollCommand,
}) => {
  const glyphs = getGlyphs();
  // Resolved terminal column count for the row estimator. Prefer the prop
  // (app.tsx feeds useStdout().columns); fall back to a direct stdout read so
  // the estimator is never left with 0/undefined.
  const resolvedColumns = (columns && columns > 0)
    ? columns
    : (typeof process !== "undefined" && process.stdout?.columns) || 80;

  // ---------------------------------------------------------------------------
  // Measured row cache — the key to accurate scroll geometry.
  // ---------------------------------------------------------------------------
  // After each render we walk the currently-mounted message nodes and record
  // their REAL height (as computed by yoga, accounting for terminal wrapping
  // and CJK glyph width). `rowsOf()` prefers the measured value and falls back
  // to estimateMessageRows() for messages that have never been on-screen.
  // Each message is measured at most once per content change; the cache makes
  // scroll geometry exact for everything the user has scrolled past, while
  // far-off unmeasured messages only contribute a (slightly inaccurate) total
  // to maxScroll — which solely affects the scrollbar thumb length, not
  // correctness of what is shown.
  const rowCacheRef = useRef<Map<string, number>>(new Map());
  const itemRefs = useRef<Map<string, DOMElement | null>>(new Map());

  // rowsOf returns the best known row count for a message: the MEASURED yoga
  // height if we have one, otherwise the column-aware estimate.
  //
  // We take max(measured, estimate) rather than measured alone for two reasons:
  //  1. Never UNDER-estimate. If measured < estimate (can happen transiently
  //     mid-layout, or for a message whose content changed since it was last
  //     measured), trusting the smaller value shrinks totalRows / maxScroll
  //     and the scroll range collapses — on tall terminals maxScroll hits 0
  //     and the user "can only see the last message" because flex-end clips
  //     everything above it. max() guarantees the scrollable range only ever
  //     grows as we learn more, never shrinks below the stable estimate.
  //  2. Avoid the historical blank-screen loop. A pure measured value
  //     fluctuates frame-to-frame during streaming (content grows per token),
  //     which used to thrash maxScroll → clamp effect → setScrollOffset loop.
  //     max(measured, estimate) is monotonic non-decreasing within a content
  //     state, so totalRows/maxScroll only grow (absorbed by the auto-follow
  //     "stay near bottom" logic) and never trigger the contraction loop.
  const rowsOf = (msg: ChatMessageData): number => {
    const measured = rowCacheRef.current.get(msg.id);
    const est = estimateMessageRows(msg, resolvedColumns);
    return measured && measured > 0 ? Math.max(measured, est) : est;
  };

  // ---------------------------------------------------------------------------
  // Virtual scrolling state
  // NOTE: hooks below MUST run unconditionally on every render. The empty-state
  // early return used to live here (before any useState/useEffect), which
  // violated the Rules of Hooks — when messages went from empty→non-empty the
  // hook count changed between renders and React threw
  // "Rendered more hooks than during the previous render." The empty-state
  // branch is now handled AFTER all hooks (see further down).
  // ---------------------------------------------------------------------------
  const [scrollOffset, setScrollOffset] = useState(0);

  // Use viewportHeight if provided AND sane; otherwise render everything.
  // A viewportHeight below MIN is treated as "not ready" (yoga hasn't
  // stabilised) — constraining to it would shrink the visible slice toward
  // empty and blank the area. The app.tsx caller already floors this, but we
  // defend here too so MessageList is robust in isolation.
  const MIN_VIEWPORT_ROWS = 4;
  const constrainHeight = viewportHeight != null && viewportHeight >= MIN_VIEWPORT_ROWS;

  // visibleLines is the target for computeVisibleRange — how many rows of
  // messages to try to show.  We use the full viewportHeight because the outer
  // Box's overflow:"hidden" is the real safety net; if estimates are slightly
  // off the overflow clips cleanly.
  const visibleLines = constrainHeight ? viewportHeight : Number.MAX_SAFE_INTEGER;

  // Walk backward from the end, accumulating row counts, to figure out which
  // messages fit in the visible window.  We want the last N messages that fit.
  //
  // Uses rowsOf() (max of measured yoga height and the column-aware estimate).
  // This is what fixes the "tall terminal → can only see the last message"
  // symptom: on a tall window the raw estimate claims everything fits
  // (maxScroll → 0, no scrolling), but the REAL measured heights exceed the
  // viewport, so flex-end clips everything but the last message. By letting
  // measured heights into the slice math, computeVisibleRange renders a window
  // that actually fits and the scroll range reflects reality.
  //
  // The historical worry (measured heights jittering during streaming and
  // blanking the area) is handled by rowsOf taking max(measured, estimate):
  // the value is monotonic non-decreasing for a given content state, so the
  // visible slice can only grow as messages are revealed — never contract to
  // empty. The safety-net pin in computeVisibleRange covers the rest.
  const { startIdx, endIdx } = computeVisibleRange(messages, visibleLines, scrollOffset, rowsOf);

  // Max scroll offset = total rows - visible rows.
  // When scrollOffset == maxScroll, we're viewing the very first messages.
  //
  // Uses rowsOf() (measured-or-estimate) so the scrollable range matches the
  // real rendered height. With only the estimate, tall terminals made
  // totalRows ≈ visibleLines and maxScroll collapsed to 0.
  const totalRows = messages.reduce((sum, m) => sum + rowsOf(m), 0);
  const maxScroll = Math.max(0, totalRows - visibleLines);

  // Measured total (rowsOf) — used ONLY for scrollbar thumb proportion. This
  // can fluctuate safely without affecting what's rendered or scroll state.
  const measuredTotalRows = messages.reduce((sum, m) => sum + rowsOf(m), 0);

  // Track total rows so we detect growth from BOTH new messages AND streaming
  // (existing message content expanding without changing length).
  const prevTotalRows = useRef(totalRows);

  // Auto-follow: when content grows and user is near the bottom, keep the
  // latest output visible (typewriter effect).  If the user has scrolled up
  // to read history, leave their position alone.
  useEffect(() => {
    if (!constrainHeight) return;
    const rowDelta = totalRows - prevTotalRows.current;
    prevTotalRows.current = totalRows;
    // Content grew → near bottom → stay at bottom.
    if (rowDelta > 0 && scrollOffset <= 2) {
      setScrollOffset(0);
    }
  }, [totalRows, scrollOffset, constrainHeight]);

  // Clamp scrollOffset when the max changes (resize or message removal).
  useEffect(() => {
    if (!constrainHeight) return;
    setScrollOffset((prev) => Math.min(prev, maxScroll));
  }, [maxScroll, constrainHeight]);

  // Consume scroll commands from the parent. Each command carries its own
  // device-appropriate row delta (mouse wheel = small, PageUp/Down = half page,
  // arrows = 1), so this effect just applies it — no step-size guessing here.
  // Positive delta → scroll UP → increase scrollOffset (older messages).
  // Negative delta → scroll DOWN → decrease scrollOffset (newer messages).
  //
  // Keying on `scrollCommand.id` (not the object identity) means every emitted
  // event fires the effect exactly once, and the `prevIdRef` guard makes us
  // robust against React StrictMode double-invocation or a stale initial value.
  const prevCmdId = useRef(scrollCommand?.id ?? 0);
  useEffect(() => {
    if (!constrainHeight || !scrollCommand) return;
    if (scrollCommand.id === prevCmdId.current) return;
    prevCmdId.current = scrollCommand.id;
    const delta = scrollCommand.deltaRows;
    if (delta === 0) return;
    setScrollOffset((prev) =>
      delta > 0
        ? Math.min(maxScroll, prev + delta)
        : Math.max(0, prev + delta),
    );
  }, [scrollCommand]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Visible slice
  // ---------------------------------------------------------------------------
  const visibleMessages = constrainHeight
    ? messages.slice(startIdx, endIdx)
    : messages;
  const hasScrollback = constrainHeight && scrollOffset > 0;
  const hasMoreBelow = constrainHeight && scrollOffset < maxScroll;

  // ---------------------------------------------------------------------------
  // Measure mounted messages post-render and cache their real heights.
  // This runs after yoga has laid out the visible slice; each measured value
  // supersedes the estimate in `rowsOf` for subsequent geometry math.
  //
  // IMPORTANT: this effect is PASSIVE — it only writes to the cache. It must
  // NOT trigger a re-render (no setState). An earlier version called
  // setScrollOffset((p)=>p) here, which combined with unstable measured
  // heights produced a render loop that blanked the message area. The cached
  // values are picked up on the NEXT natural re-render (new message, streaming
  // token, scroll), which is always imminent in an active chat. The scrollbar
  // being one frame behind is invisible to the user; a render loop is not.
  useLayoutEffect(() => {
    itemRefs.current.forEach((node, id) => {
      if (!node) return;
      const measured = measureElement(node).height;
      // Only cache sane positive values — a 0 or negative result means yoga
      // hasn't settled (e.g. the wrapper was measured mid-layout) and would
      // corrupt totalRows if trusted.
      if (measured > 0) {
        rowCacheRef.current.set(id, measured);
      }
    });
    // Drop refs for messages no longer rendered so the maps don't grow unbounded.
    if (itemRefs.current.size > visibleMessages.length * 2) {
      const keep = new Set(visibleMessages.map((m) => m.id));
      for (const id of itemRefs.current.keys()) {
        if (!keep.has(id)) itemRefs.current.delete(id);
      }
    }
    // Depend on the slice indices, NOT on `visibleMessages` itself — the slice
    // is recreated (new array identity) on every render even when its contents
    // are identical, which would force a synchronous measureElement pass every
    // frame and add latency during scrolling. The indices change only when the
    // visible window actually moves.
  }, [startIdx, endIdx]);

  // ---------------------------------------------------------------------------
  // Empty state — AFTER all hooks. Returning here is safe because every hook
  // above (useRef/useState/useEffect/useLayoutEffect) has already been called
  // unconditionally, so the hook order is identical on every render regardless
  // of whether messages is empty.
  // ---------------------------------------------------------------------------
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} marginY={1}>
        <Text dimColor>
          {glyphs.bullet} No messages yet. Type a message or /help to get started.
        </Text>
      </Box>
    );
  }

  // Register/clear a ref for a rendered message. Returned as a callback ref so
  // we don't need a separate <Box> wrapper per message.
  const setItemRef = (id: string) => (node: DOMElement | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
  };

  // ---------------------------------------------------------------------------
  // Scrollbar geometry — the ONLY consumer of measured heights. A wobble here
  // changes the thumb appearance for one frame and triggers no state updates.
  // ---------------------------------------------------------------------------
  const scrollbarWidth = 3; // ▲/▼ + track (1 char)
  const trackHeight = constrainHeight ? Math.max(1, viewportHeight! - 2) : 0; // −2 for ▲▼
  // Guard against measuredTotalRows <= 0 (no messages measured yet) to avoid
  // divide-by-zero / NaN; fall back to the stable totalRows in that case.
  const denom = measuredTotalRows > 0 ? measuredTotalRows : totalRows;
  const thumbSize = constrainHeight
    ? Math.max(1, Math.floor((visibleLines / denom) * trackHeight))
    : 0;
  const thumbPos = constrainHeight && maxScroll > 0
    ? Math.floor(
      ((maxScroll - scrollOffset) / maxScroll) * Math.max(0, trackHeight - thumbSize),
    )
    : 0;

  // Build scrollbar track array (each row is a glyph for that track position).
  const trackRows: string[] = constrainHeight
    ? Array.from({ length: trackHeight }, (_, i) =>
        i >= thumbPos && i < thumbPos + thumbSize
          ? glyphs.scrollThumb
          : glyphs.scrollTrack,
      )
    : [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  // The outer Box carries both the hard height constraint AND overflow
  // clipping.  This guarantees content never leaks beyond viewportHeight rows,
  // regardless of residual estimation errors in computeVisibleRange. The gap
  // between this Box and the input area is empty flex space in the body Box.
  // ---------------------------------------------------------------------------
  return (
    <Box
      flexDirection="row"
      flexGrow={constrainHeight ? undefined : 1}
      height={constrainHeight ? viewportHeight : undefined}
      overflow={constrainHeight ? "hidden" : undefined}
    >
      {/* Message content.
          Alignment is chosen by whether content overflows the viewport:
            - Overflowing (virtual scroll active) → justifyContent="flex-start".
              Messages pack contiguously from the top, and the window is
              positioned purely by scrollOffset. This is the fix for the
              "blank gap then jumps to another turn" symptom: flex-end was
              pushing a too-short visible slice to the bottom, leaving a hole
              above it that grew/shrank as the slice changed — reading like
              disjointed turns.
            - Fits in viewport (short conversation) → justifyContent="flex-end"
              keeps the latest turn at the bottom of the visible area, the
              natural place to look when idle. There is no scroll involved, so
              no gap can open between turns. */}
      <Box
        flexGrow={1}
        flexDirection="column"
        justifyContent={measuredTotalRows >= visibleLines ? "flex-start" : "flex-end"}
      >
        {/* Scroll indicator — messages above */}
        {hasScrollback && (
          <Text dimColor>
            {glyphs.scrollUp} {scrollOffset} earlier  ↑↓ scroll
          </Text>
        )}

        {/* Visible messages — each is wrapped in a measured Box so its real
            post-layout height can be cached for accurate scroll geometry. */}
        {visibleMessages.map((msg) => (
          <Box key={msg.id} ref={setItemRef(msg.id)} flexDirection="column" flexShrink={0}>
            <Message message={msg} showTimestamps={showTimestamps} />
          </Box>
        ))}

        {/* Scroll indicator — messages below */}
        {hasMoreBelow && (
          <Text dimColor>
            {glyphs.scrollDown} {messages.length - startIdx - visibleMessages.length} below  ↑↓ scroll
          </Text>
        )}
      </Box>

      {/* Scrollbar — only when content exceeds the viewport */}
      {constrainHeight && messages.length > visibleMessages.length && (
        <Box flexDirection="column" width={scrollbarWidth} flexShrink={0}>
          <Text dimColor>{glyphs.scrollUp}</Text>
          {trackRows.map((ch, i) => (
            <Text key={i} dimColor={ch === glyphs.scrollTrack}>
              {ch}
            </Text>
          ))}
          <Text dimColor>{glyphs.scrollDown}</Text>
        </Box>
      )}
    </Box>
  );
};

// =============================================================================
// Compute the visible message range from scroll offset.
//
// Walks from the end (newest message) backward, accumulating estimated row
// counts.  `scrollOffset` = how many "steps" back from the latest we are.
// Returns [startIdx, endIdx) for the slice that fits in `visibleLines`.
// =============================================================================

function computeVisibleRange(
  messages: ChatMessageData[],
  visibleLines: number,
  scrollOffset: number,
  rowsOf: (msg: ChatMessageData) => number,
): { startIdx: number; endIdx: number } {
  if (messages.length === 0) return { startIdx: 0, endIdx: 0 };
  if (!isFinite(visibleLines)) return { startIdx: 0, endIdx: messages.length };

  // Accumulate rows from the END backward.  "offset" = how many rows' worth
  // of messages to skip from the very end (the "scrolled back" amount).
  let rowsFromEnd = 0;
  let end = messages.length; // exclusive

  // Skip `scrollOffset` rows' worth from the end.
  let skipRemaining = scrollOffset;
  for (let i = messages.length - 1; i >= 0 && skipRemaining > 0; i--) {
    const r = rowsOf(messages[i]!);
    if (r <= skipRemaining) {
      skipRemaining -= r;
      end = i;
    } else {
      // Partially skip this message — not ideal but breaks the loop cleanly.
      end = i + 1;
      break;
    }
  }

  // Now accumulate `visibleLines` rows' worth going further backward.
  let accumulated = 0;
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const r = rowsOf(messages[i]!);
    if (accumulated + r <= visibleLines) {
      accumulated += r;
      start = i;
    } else {
      break;
    }
  }

  // Safety net: NEVER return an empty range when there are messages to show.
  // If visibleLines is smaller than even a single message's estimated height
  // (e.g. a transiently tiny viewport during layout), the loop above leaves
  // start === end and the slice would be empty — rendering a BLANK message
  // area. Pin `start` to the last available index so at least the newest
  // message is always rendered; the outer Box's overflow:"hidden" clips it
  // gracefully. This is the hard floor that makes blank screens impossible.
  if (start === end && end > 0) {
    start = end - 1;
  }

  return { startIdx: start, endIdx: end };
}
