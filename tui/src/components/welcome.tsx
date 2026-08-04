// =============================================================================
// Welcome screen — clean, minimal. Shown when idle with no messages.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";

// =============================================================================
// Props
// =============================================================================

export interface WelcomeScreenProps {
  model: string | null;
  agentName: string;
  serverUrl: string;
  columns?: number;
}

// =============================================================================
// Component
// =============================================================================

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  model,
  agentName,
}) => {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingY={1}>
      {/* Brand */}
      <Box flexDirection="row">
        <Text bold color={COLORS.primary}>octopus</Text>
        <Text dimColor> — AI agent</Text>
      </Box>

      {/* Info */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>  model   {model ?? "—"}</Text>
        <Text dimColor>  agent   @{agentName}</Text>
      </Box>

      {/* Ready prompt */}
      <Box marginTop={1}>
        <Text color={COLORS.primary}>Ready to code! What would you like to build?</Text>
      </Box>

      {/* Hint */}
      <Box marginTop={0}>
        <Text dimColor>  /help for commands · Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
};
