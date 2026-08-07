// =============================================================================
// File-edit tool — amber left-border + Git-style diff
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { MessageProps } from "./shared.js";
import { getGlyphs } from "../../terminal/config-ui.js";
import { COLORS } from "../../terminal/theme.js";
import { Timestamp } from "./shared.js";

const MAX_DIFF_LINES = 15;

export const FileEditToolView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const toolName = (message.metadata?.toolName as string) ?? "edit_file";
  const toolStatus = (message.metadata?.toolStatus as string) ?? "done";
  const toolArgs = (message.metadata?.toolArgs ?? {}) as Record<string, unknown>;
  const diffStats = message.metadata?.diffStats as { added: number; removed: number } | undefined;

  const filePath = (toolArgs.file_path ?? toolArgs.path ?? "") as string;
  const isRunning = toolStatus === "running";
  const isError = toolStatus === "error" || toolStatus === "rejected";

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* ⏺ edit_file path +N -M ⠋ — single text line */}
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} </Text>
        <Text bold color={COLORS.tool}>{toolName}</Text>
        {filePath && <Text> {filePath}</Text>}
        {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
          <Text>
            {"  "}
            <Text color={COLORS.success}>+{diffStats.added}</Text>
            {" "}
            <Text color={COLORS.error}>-{diffStats.removed}</Text>
          </Text>
        )}
        {isRunning && (
          <Text color={COLORS.warning}>  ●</Text>
        )}
        {isError && (
          <Text color={COLORS.error}>  {glyphs.cross}</Text>
        )}
        {!isRunning && !isError && (
          <Text color={COLORS.success}>  {glyphs.checkmark}</Text>
        )}
      </Box>

      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};
