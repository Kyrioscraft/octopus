// =============================================================================
// ThinkingBlock — renders the "thinking/reasoning" phase of an agent.
// Equivalent to tui-solution.md §5.2.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentBlock } from "../../types.js";
import { Spinner } from "../../terminal/use-frame.js";

export interface ThinkingBlockProps {
  block: AgentBlock & { type: "thinking" };
}

/**
 * Thinking / reasoning block.
 *
 * - running:   displays animated spinner + last 60 chars of thinking content
 * - done:      displays "Thinking complete" + char count (then enters <Static>)
 */
export const ThinkingBlock: React.FC<ThinkingBlockProps> = React.memo(({ block }) => {
  if (block.status === "running") {
    const snippet: ReactNode[] = [];
    snippet.push(
      React.createElement(Text, { dimColor: true, key: "label" }, "  Thinking  "),
      React.createElement(Spinner, { key: "spin" }),
    );
    if (block.content) {
      snippet.push(
        React.createElement(Text, { dimColor: true, key: "tail" }, `  ${block.content.slice(-60)}`),
      );
    }
    return React.createElement(Box, { gap: 0 }, ...snippet);
  }

  // status === "done" → final frame before entering <Static>
  const parts: ReactNode[] = [
    React.createElement(Text, { color: "green", key: "done" }, "  Thinking complete"),
  ];
  if (block.content) {
    parts.push(
      React.createElement(Text, { dimColor: true, key: "count" }, `  (${block.content.length} chars)`),
    );
  }
  return React.createElement(Box, { gap: 0 }, ...parts);
});

ThinkingBlock.displayName = "ThinkingBlock";
