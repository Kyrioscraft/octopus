// =============================================================================
// ConfirmBlock — renders a y/n confirmation prompt inline in the conversation.
// Equivalent to architecture/tui-solution.md §5.5.
// =============================================================================

import React from "react";
import { Box, Text, useInput } from "ink";
import type { AgentBlock } from "../../types.js";

export interface ConfirmBlockProps {
  block: AgentBlock & { type: "confirm" };
  /** Called when user presses y or n. Only relevant for active (pending) blocks. */
  onAnswer?: (approved: boolean) => void;
}

/**
 * Inline confirmation prompt.
 *
 * - pending:   "⚠️ message" + "[y] 批准  [n] 拒绝"  (waits for user keypress)
 * - approved:  "⚠️ message [已批准 ✓]" (then enters <Static>)
 * - rejected:  "⚠️ message [已拒绝 ✗]" (then enters <Static>)
 *
 * When `onAnswer` is provided and the block is pending, `useInput` captures
 * y/n/Y/N keypresses and calls `onAnswer(true/false)`.
 */
export const ConfirmBlock: React.FC<ConfirmBlockProps> = React.memo(({ block, onAnswer }) => {
  // Only capture input when the block is pending and we have a callback.
  useInput((input, _key) => {
    if (block.status !== "pending" || !onAnswer) return;

    if (input === "y" || input === "Y") {
      onAnswer(true);
    } else if (input === "n" || input === "N") {
      onAnswer(false);
    }
  });

  // --- Approved ---
  if (block.status === "approved") {
    return React.createElement(
      Box,
      null,
      React.createElement(Text, { color: "green" }, `\u26A0\uFE0F  ${block.message} [\u5DF2\u6279\u51C6 \u2713]`),
    );
  }

  // --- Rejected ---
  if (block.status === "rejected") {
    return React.createElement(
      Box,
      null,
      React.createElement(Text, { color: "red" }, `\u26A0\uFE0F  ${block.message} [\u5DF2\u62D2\u7EDD \u2717]`),
    );
  }

  // --- Pending (active, waiting for user input) ---
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: "yellow", bold: true }, `\u26A0\uFE0F  ${block.message}`),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: "cyan" }, "[y] \u6279\u51C6  [n] \u62D2\u7EDD"),
    ),
  );
});

ConfirmBlock.displayName = "ConfirmBlock";
