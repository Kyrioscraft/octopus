// =============================================================================
// BlockView — dispatcher that routes an AgentBlock to its renderer.
// Equivalent to the BlockView component in tui-solution.md §5.1.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { AgentBlock } from "../../types.js";
import { ThinkingBlock, type ThinkingBlockProps } from "./thinking.js";
import { TextBlock, type TextBlockProps } from "./text.js";
import { ToolCallBlock, type ToolCallBlockProps } from "./tool-call.js";
import { ConfirmBlock, type ConfirmBlockProps } from "./confirm.js";

export interface BlockViewProps {
  block: AgentBlock;
  /** Called when a confirm block is answered (y/n). Only used for active confirm blocks. */
  onConfirmAnswer?: (approved: boolean) => void;
  /** Show a "> " prefix for user text blocks. */
  showUserPrefix?: boolean;
}

/**
 * Route a block to its type-specific renderer.
 *
 * Components do not need to know whether they're inside `<Static>` or the
 * dynamic region — they render the same output given the same block state.
 */
export const BlockView: React.FC<BlockViewProps> = React.memo(({ block, onConfirmAnswer, showUserPrefix }) => {
  switch (block.type) {
    case "thinking":
      return <ThinkingBlock block={block} />;
    case "text":
      if (showUserPrefix) {
        return (
          <Box flexDirection="row">
            <Text color="#7AA2F7">{"> "}</Text>
            <TextBlock block={block} />
          </Box>
        );
      }
      return <TextBlock block={block} />;
    case "tool_call":
      return <ToolCallBlock block={block} />;
    case "confirm":
      return <ConfirmBlock block={block} onAnswer={onConfirmAnswer} />;
  }
});

BlockView.displayName = "BlockView";

// Re-export for convenience
export { ThinkingBlock } from "./thinking.js";
export { TextBlock } from "./text.js";
export { ToolCallBlock } from "./tool-call.js";
export { ConfirmBlock } from "./confirm.js";
export type { ThinkingBlockProps, TextBlockProps, ToolCallBlockProps, ConfirmBlockProps };
