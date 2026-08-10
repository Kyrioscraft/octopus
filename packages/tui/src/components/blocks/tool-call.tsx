// =============================================================================
// ToolCallBlock — renders a tool invocation and its result.
// Equivalent to tui-solution.md §5.4.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { AgentBlock } from "../../types.js";
import { Spinner } from "../../terminal/use-frame.js";

export interface ToolCallBlockProps {
  block: AgentBlock & { type: "tool_call" };
}

const MAX_TOOL_OUTPUT = 500;
const MAX_TOOL_LINES = 10;

function formatInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).slice(0, 2);
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
}

function truncateOutput(s: string): string {
  if (!s) return "";
  const lines = s.split("\n");
  if (lines.length <= MAX_TOOL_LINES && s.length <= MAX_TOOL_OUTPUT) return s;
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
 * - done:     success/error glyph + truncated output
 */
export const ToolCallBlock: React.FC<ToolCallBlockProps> = React.memo(({ block }) => {
  if (block.status === "pending") {
    // Pending — waiting its turn, shown dimmed without spinner
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text dimColor>🔧 {block.tool}</Text>
          <Text dimColor>{formatInput(block.input)}</Text>
        </Box>
      </Box>
    );
  }

  if (block.status === "running") {
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Spinner />
          <Text color="yellow">🔧 {block.tool}</Text>
          <Text dimColor>{formatInput(block.input)}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {block.error ? (
          <Text color="red">🔧 {block.tool} [✗ error]</Text>
        ) : (
          <Text color="green">🔧 {block.tool} [✓ done]</Text>
        )}
        <Text dimColor>{formatInput(block.input)}</Text>
      </Box>
      {block.output ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>┌─ output ─</Text>
          <Text dimColor>{truncateOutput(block.output)}</Text>
          <Text dimColor>└──────────</Text>
        </Box>
      ) : null}
      {block.error ? (
        <Box paddingLeft={2}>
          <Text color="red">{block.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

ToolCallBlock.displayName = "ToolCallBlock";
