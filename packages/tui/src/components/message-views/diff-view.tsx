// =============================================================================
// Diff — amber left-border
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { MessageProps } from "./shared.js";
import { getGlyphs } from "../../terminal/config-ui.js";
import { LeftStrip, OutputGutter, Timestamp } from "./shared.js";
import { COLORS } from "../../terminal/theme.js";

export const DiffMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const lines = message.content.split("\n");
  const shown = lines.slice(0, 30);

  return (
    <LeftStrip color={COLORS.tool}>
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} Diff</Text>
      </Box>
      <OutputGutter>
        {shown.map((line, i) => {
          const color = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
          return <Text key={i} color={color}>{line}</Text>;
        })}
      </OutputGutter>
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};
