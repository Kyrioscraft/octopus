// =============================================================================
// ToolCallBlock — renders a tool invocation and its result.
// Equivalent to tui-solution.md §5.4.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentBlock } from "../../types.js";
import { Spinner } from "../../terminal/use-frame.js";

export interface ToolCallBlockProps {
  block: AgentBlock & { type: "tool_call" };
}

/** Maximum characters of tool output to display. */
const MAX_TOOL_OUTPUT = 500;
/** Maximum lines of tool output to display. */
const MAX_TOOL_LINES = 10;

/** Format tool input arguments for display (first 2 entries). */
function formatInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).slice(0, 2);
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
}

/** Truncate tool output text to MAX_TOOL_OUTPUT chars / MAX_TOOL_LINES lines. */
function truncateOutput(s: string): string {
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= MAX_TOOL_LINES && s.length <= MAX_TOOL_OUTPUT) {
    return s;
  }
  const truncated = lines.slice(0, MAX_TOOL_LINES).join("\n");
  if (truncated.length > MAX_TOOL_OUTPUT) {
    return truncated.slice(0, MAX_TOOL_OUTPUT) + "\n... (truncated)";
  }
  return truncated + `\n... (${lines.length - MAX_TOOL_LINES} more lines)`;
}

/**
 * Tool call block.
 *
 * - running:  spinner + tool name + formatted input args
 * - done:     success/error glyph + output preview (truncated)
 */
export const ToolCallBlock: React.FC<ToolCallBlockProps> = React.memo(({ block }) => {
  if (block.status === "running") {
    return React.createElement(
      Box,
      { flexDirection: "column" },
      React.createElement(
        Box,
        { gap: 1 },
        React.createElement(Spinner, { key: "spin" }),
        React.createElement(Text, { key: "tool", color: "yellow" }, `\uD83D\uDD27 ${block.tool}`),
        React.createElement(Text, { key: "args", dimColor: true }, formatInput(block.input)),
      ),
    );
  }

  // status === "done"
  const headerItems: ReactNode[] = [];

  if (block.error) {
    headerItems.push(
      React.createElement(Text, { key: "err", color: "red" }, `\uD83D\uDD27 ${block.tool} [\u2717 error]`),
    );
  } else {
    headerItems.push(
      React.createElement(Text, { key: "ok", color: "green" }, `\uD83D\uDD27 ${block.tool} [\u2713 done]`),
    );
  }

  headerItems.push(
    React.createElement(Text, { key: "args", dimColor: true }, `  ${formatInput(block.input)}`),
  );

  const children: ReactNode[] = [
    React.createElement(Box, { key: "header", gap: 0 }, ...headerItems),
  ];

  if (block.output) {
    children.push(
      React.createElement(
        Box,
        { key: "output-container", paddingLeft: 2, flexDirection: "column" },
        React.createElement(Text, { dimColor: true, key: "pre" }, "\u250C\u2500 output \u2500"),
        React.createElement(Text, { dimColor: true, key: "out" }, truncateOutput(block.output)),
        React.createElement(Text, { dimColor: true, key: "post" }, "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"),
      ),
    );
  }

  if (block.error) {
    children.push(
      React.createElement(
        Box,
        { key: "error-container", paddingLeft: 2 },
        React.createElement(Text, { color: "red" }, block.error),
      ),
    );
  }

  return React.createElement(Box, { flexDirection: "column" }, ...children);
});

ToolCallBlock.displayName = "ToolCallBlock";
