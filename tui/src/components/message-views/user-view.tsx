// =============================================================================
// User message — blue left-border + "> " prefix
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { MessageProps } from "./shared.js";
import { COLORS } from "../../terminal/theme.js";
import { LeftStrip, Timestamp } from "./shared.js";

export const UserMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <LeftStrip color={COLORS.primary}>
      <Box flexDirection="row">
        <Text bold color={COLORS.primary}>{">"}</Text>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <Text>{message.content}</Text>
        </Box>
      </Box>
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};
