// =============================================================================
// ErrorScreen — shown when server connection fails.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { InputMode } from "../../types.js";
import { ChatInput } from "../chat-input.js";

export interface ErrorScreenProps {
  serverError: string | null;
  serverUrl: string;
  /** Input mode for ChatInput. */
  inputMode: InputMode;
  /** Mode change handler. */
  onModeChange: (mode: InputMode) => void;
  /** Submit handler (for recovery commands like /reload). */
  onSubmit: (text: string, mode: InputMode) => void;
}

export const ErrorScreen: React.FC<ErrorScreenProps> = ({
  serverError, serverUrl, inputMode, onModeChange, onSubmit,
}) => {
  // The phase is "startup_error" — pass it explicitly.
  const phase = "startup_error" as const;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Brand header */}
      <Box marginBottom={1}>
        <Text backgroundColor="cyan" color="black" bold>{" "}🐙 Octopus TUI{" "}</Text>
      </Box>

      {/* Error card */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="red"
        paddingX={2}
        paddingY={1}
      >
        <Box marginBottom={1}>
          <Text color="red" bold>✗ Connection Failed</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="red">{serverError}</Text>
        </Box>
        <Box>
          <Text dimColor>Server URL: </Text>
          <Text>{serverUrl}</Text>
        </Box>
      </Box>

      {/* Recovery commands */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Recovery:</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>
            <Text color="cyan" bold>/reload</Text>
            <Text dimColor>  — retry the connection</Text>
          </Text>
          <Text>
            <Text color="cyan" bold>/install</Text>
            <Text dimColor>  — install missing dependencies</Text>
          </Text>
          <Text>
            <Text color="cyan" bold>/quit</Text>
            <Text dimColor>  — exit the application</Text>
          </Text>
        </Box>
      </Box>

      <ChatInput
        inputMode={inputMode}
        phase={phase}
        onModeChange={onModeChange}
        onSubmit={(text, mode) => onSubmit(text, mode)}
      />
    </Box>
  );
};
