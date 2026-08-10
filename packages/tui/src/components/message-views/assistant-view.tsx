// =============================================================================
// Assistant message — NO border, NO prefix, pure markdown
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { MessageProps } from "./shared.js";
import { Timestamp } from "./shared.js";
import { getGlyphs } from "../../terminal/config-ui.js";
import { Markdown } from "../markdown.js";
import { COLORS } from "../../terminal/theme.js";

export const ReasoningBlock: React.FC<{ reasoning: string; isRunning: boolean }> = ({ reasoning: _reasoning, isRunning }) => {
  const glyphs = getGlyphs();
  if (!isRunning) {
    return (
      <Box flexDirection="row" paddingLeft={1}>
        <Text dimColor>{glyphs.checkmark} Thinking</Text>
      </Box>
    );
  }
  const lines = _reasoning.split("\n").filter((l) => l.trim().length > 0);
  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      <Text dimColor>{glyphs.toolCall} Thinking...</Text>
      {lines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {lines.slice(-8).map((l, i) => (
            <Text key={i} dimColor>{l}</Text>
          ))}
          {lines.length > 8 && <Text dimColor>  ... ({lines.length - 8} more lines)</Text>}
        </Box>
      )}
    </Box>
  );
};

export const AssistantMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const reasoning = message.metadata?.reasoning as string | undefined;
  const isFinalized = message.metadata?.finalized === true;
  const hasContent = message.content.length > 0;

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {reasoning && <ReasoningBlock reasoning={reasoning} isRunning={!isFinalized} />}
      {hasContent ? (
        <Box flexDirection="row">
          <Box flexDirection="column" flexGrow={1}>
            {isFinalized ? <Markdown>{message.content}</Markdown> : <Text>{message.content}</Text>}
          </Box>
          {!isFinalized && <Text color={COLORS.primary}>▋</Text>}
        </Box>
      ) : !isFinalized ? (
        <Text dimColor>● Thinking...</Text>
      ) : (
        <Text dimColor>(empty response)</Text>
      )}
      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};
