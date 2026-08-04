// =============================================================================
// ConnectingScreen — shown while the TUI connects to the server.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import { Loading } from "../loading.js";

export interface ConnectingScreenProps {
  serverUrl: string;
}

export const ConnectingScreen: React.FC<ConnectingScreenProps> = ({ serverUrl }) => {
  return (
    <Box flexDirection="column" padding={1}>
      {/* Brand header */}
      <Box marginBottom={1}>
        <Text backgroundColor="cyan" color="black" bold>{" "}🐙 Octopus TUI{" "}</Text>
      </Box>

      {/* Status card */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
      >
        <Box>
          <Text color="yellow" bold>⏳ Connecting</Text>
          <Text dimColor> to </Text>
          <Text color="cyan">{serverUrl}</Text>
        </Box>
        <Box marginY={1}>
          <Loading status="Thinking" detail="Checking server health..." />
        </Box>
      </Box>

      {/* Help footer */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {"  "}Press <Text bold>Ctrl+C</Text> to exit.
        </Text>
        <Text dimColor>
          {"  "}Start the server: <Text>cd server && npm run dev</Text>
        </Text>
      </Box>
    </Box>
  );
};
