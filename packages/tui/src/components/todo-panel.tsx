// =============================================================================
// TodoPanel — persistent todo list widget (Claude Code style).
//
// Renders the agent's internal todo list from write_todos calls as a
// compact panel between the chat area and the chrome region. Updates
// in-place whenever the agent calls write_todos.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { TodoItem as TodoItemType } from "../types.js";

// =============================================================================
// Props
// =============================================================================

export interface TodoPanelProps {
  items: TodoItemType[];
}

// =============================================================================
// Status → glyph + color
// =============================================================================

const STATUS_GLYPH: Record<string, { glyph: string; color: string }> = {
  completed:   { glyph: "✓", color: "green" },
  in_progress: { glyph: "●", color: "#7AA2F7" },  // primary blue
  pending:     { glyph: "○", color: "gray" },
};

const PRIORITY_LABEL: Record<string, string> = {
  high:   "⚡",
  medium: "  ",
  low:    "  ",
};

// =============================================================================
// Component
// =============================================================================

export const TodoPanel: React.FC<TodoPanelProps> = React.memo(({ items }) => {
  if (items.length === 0) return null;

  // Count stats
  const done = items.filter((t) => t.status === "completed").length;
  const total = items.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#7AA2F7" paddingX={1}>
      {/* Header */}
      <Box>
        <Text bold color="#7AA2F7">📋 Tasks</Text>
        <Text dimColor>  {done}/{total} done</Text>
      </Box>

      {/* Items */}
      {items.map((item, i) => {
        const status = STATUS_GLYPH[item.status] ?? STATUS_GLYPH.pending;
        const priority = PRIORITY_LABEL[item.priority ?? "medium"] ?? "";
        const isActive = item.status === "in_progress";

        return (
          <Box key={i}>
            <Text color={status.color}>{status.glyph} </Text>
            {priority ? <Text dimColor>{priority} </Text> : null}
            <Text color={isActive ? "#7AA2F7" : undefined} dimColor={item.status === "completed"}>
              {item.content}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});

TodoPanel.displayName = "TodoPanel";
