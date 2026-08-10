// =============================================================================
// ThinkingBlock — renders the "thinking/reasoning" phase of an agent.
// Equivalent to tui-solution.md §5.2.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
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
    return (
      <Box gap={0}>
        <Spinner />
        <Text dimColor>  Thinking</Text>
      </Box>
    );
  }

  // status === "done" → final frame before entering <Static>
  if (block.content) {
    return (
      <Box gap={0}>
        <Text color="gray">  Thought for</Text>
        <Text dimColor> {block.content.length} chars</Text>
      </Box>
    );
  }
  return (
    <Box gap={0}>
      <Text color="gray">  Thought complete</Text>
    </Box>
  );
});

ThinkingBlock.displayName = "ThinkingBlock";
