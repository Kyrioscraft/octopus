// =============================================================================
// ExploreWidget — single-line subagent activity indicator.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { ChatMessageData } from "../types.js";
import type { SubagentActivityMeta } from "../types.js";
import { getGlyphs } from "../terminal/config-ui.js";
import { useFrame } from "../terminal/use-frame.js";
import { COLORS } from "../terminal/theme.js";

export interface ExploreWidgetProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

export const ExploreWidget: React.FC<ExploreWidgetProps> = React.memo(({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const frame = useFrame();
  const meta = (message.metadata ?? {}) as Partial<SubagentActivityMeta>;
  const status = meta.status ?? "running";
  const tools = meta.tools ?? [];

  const isRunning = status === "running";
  const toolCount = tools.length;
  const doneCount = tools.filter((t) => t.status === "done").length;
  const hasProgress = toolCount > 0;

  return (
    <Box flexDirection="row" paddingLeft={1}>
      {isRunning ? (
        <Text color={COLORS.warning}>{frame}</Text>
      ) : (
        <Text color={COLORS.success}>{glyphs.checkmark}</Text>
      )}
      <Text bold color={COLORS.tool}> Explore</Text>
      {hasProgress && <Text dimColor>  {doneCount}/{toolCount}</Text>}
      {showTimestamps && (
        <Text dimColor>  {new Date(message.timestamp).toLocaleTimeString()}</Text>
      )}
    </Box>
  );
});
