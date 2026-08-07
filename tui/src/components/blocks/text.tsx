// =============================================================================
// TextBlock — renders streaming / completed text output from the agent.
// Equivalent to tui-solution.md §5.3.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
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
 *
 * Uses the existing TUI MarkdownRenderer for content display, matching the
 * look of the current assistant message view.
 */
export const TextBlock: React.FC<TextBlockProps> = React.memo(({ block }) => {
  const children: ReactNode[] = [];

  if (block.content) {
    children.push(
      React.createElement(Markdown, { key: "md", children: block.content }),
    );
  }

  if (block.status === "streaming") {
    children.push(
      React.createElement(Text, { key: "cursor", color: "cyan" }, "│"),
    );
  }

  if (children.length === 0) {
    return null;
  }

  return React.createElement(Box, { flexDirection: "column" }, ...children);
});

TextBlock.displayName = "TextBlock";
