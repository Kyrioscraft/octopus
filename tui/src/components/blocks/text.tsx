// =============================================================================
// TextBlock — renders streaming / completed text output from the agent.
// Equivalent to tui-solution.md §5.3.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { AgentBlock } from "../../types.js";
import { Markdown } from "../markdown.js";

export interface TextBlockProps {
  block: AgentBlock & { type: "text" };
}

/**
 * Streaming / completed text block.
 *
 * - streaming:  renders the full content + a blinking cursor indicator
 * - done:       renders the final content (then enters <Static>)
 */
export const TextBlock: React.FC<TextBlockProps> = React.memo(({ block }) => {
  if (!block.content && block.status !== "streaming") return null;

  return (
    <Box flexDirection="column">
      {block.content ? <Markdown>{block.content}</Markdown> : null}
      {block.status === "streaming" && <Text color="cyan">│</Text>}
    </Box>
  );
});

TextBlock.displayName = "TextBlock";
