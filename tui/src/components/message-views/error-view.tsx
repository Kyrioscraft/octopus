// =============================================================================
// Error — pink left-border + ✗
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { MessageProps } from "./shared.js";
import { getGlyphs } from "../../terminal/config-ui.js";
import { LeftStrip, Timestamp } from "./shared.js";
import { COLORS } from "../../terminal/theme.js";

export const ErrorMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  return (
    <LeftStrip color={COLORS.error}>
      <Box flexDirection="row">
        <Text bold color={COLORS.error}>{glyphs.cross}</Text>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <Text color={COLORS.error}>{message.content}</Text>
        </Box>
      </Box>
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};
