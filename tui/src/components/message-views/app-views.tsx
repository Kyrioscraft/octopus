// =============================================================================
// App / system — no border, dim italic
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { MessageProps } from "./shared.js";
import { getGlyphs } from "../../terminal/config-ui.js";
import { LeftStrip, OutputGutter, Timestamp } from "./shared.js";
import { COLORS } from "../../terminal/theme.js";

export const AppMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <Box flexDirection="row" paddingLeft={1} marginBottom={1}>
      <Text dimColor italic>{message.content}</Text>
      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};

// =============================================================================
// Skill — purple left-border + / skill:name
// =============================================================================

export const SkillMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const skillName = (message.metadata?.skillName as string) ?? "skill";
  return (
    <LeftStrip color={COLORS.skill}>
      <Box flexDirection="row">
        <Text bold color={COLORS.skill}>/ skill:{skillName}</Text>
      </Box>
      {message.content && (
        <OutputGutter>
          <Text dimColor>{message.content}</Text>
        </OutputGutter>
      )}
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// Summarization — no border, dim
// =============================================================================

export const SummarizationMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <Box flexDirection="row" paddingLeft={1} marginBottom={1}>
      <Text dimColor italic>{message.content}</Text>
      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};
