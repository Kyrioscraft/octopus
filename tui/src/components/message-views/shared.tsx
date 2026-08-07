// =============================================================================
// Shared primitives for message views — extracted from messages.tsx.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { ChatMessageData } from "../../types.js";
import { getGlyphs } from "../../terminal/config-ui.js";

// =============================================================================
// Props
// =============================================================================

export interface MessageProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

// =============================================================================
// Components
// =============================================================================

/** A Box with only the left border rendered, in the given accent color. */
export const LeftStrip: React.FC<{
  color: string;
  children: React.ReactNode;
}> = ({ color, children }) => (
  <Box
    flexDirection="column"
    borderStyle="single"
    borderColor={color}
    borderRight={false}
    borderTop={false}
    borderBottom={false}
    paddingLeft={1}
    marginBottom={1}
  >
    {children}
  </Box>
);

/** Fixed-width hanging indent gutter (⎿ column). */
export const OutputGutter: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const glyphs = getGlyphs();
  return (
    <Box flexDirection="row" marginTop={0}>
      <Box width={2} flexShrink={0}>
        <Text dimColor>{glyphs.branch}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
};

/** Renders a dimmed timestamp from ChatMessageData. */
export const Timestamp: React.FC<{ message: ChatMessageData }> = ({ message }) => (
  <Text dimColor> {new Date(message.timestamp).toLocaleTimeString()}</Text>
);
