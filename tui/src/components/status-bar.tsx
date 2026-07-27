// =============================================================================
// Status bar component — model, thread, phase, token usage.
// Equivalent to Python tui.widgets.status.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { AppPhase, SpinnerStatus, SessionStats } from "../types.js";
import { formatTokenCount } from "../formatting.js";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Props
// =============================================================================

export interface StatusBarProps {
  model: string | null;
  threadId: string | null;
  phase: AppPhase;
  spinner: SpinnerStatus;
  stats: SessionStats;
  agentName?: string;
}

// =============================================================================
// Component
// =============================================================================

const StatusBarImpl: React.FC<StatusBarProps> = ({
  model,
  threadId,
  phase,
  spinner,
  stats,
  agentName,
}) => {
  const glyphs = getGlyphs();
  const phaseLabel = getPhaseLabel(phase, spinner, glyphs);

  return (
    <Box
      flexDirection="row"
      paddingX={1}
      paddingY={0}
    >
      <Text backgroundColor="cyan" color="black"> Octopus </Text>
      <Text> </Text>

      {/* Phase / status */}
      <Text dimColor>{phaseLabel}</Text>

      {/* Separator */}
      {model && (
        <>
          <Text dimColor> {glyphs.boxVertical} </Text>
          <Text dimColor>{model}</Text>
        </>
      )}

      {/* Agent name */}
      {agentName && (
        <>
          <Text dimColor> {glyphs.boxVertical} </Text>
          <Text dimColor>@{agentName}</Text>
        </>
      )}

      {/* Thread ID */}
      {threadId && (
        <>
          <Text dimColor> {glyphs.boxVertical} </Text>
          <Text dimColor>#{threadId.slice(0, 8)}</Text>
        </>
      )}

      {/* Token stats */}
      {stats.requestCount > 0 && (
        <>
          <Text dimColor> {glyphs.boxVertical} </Text>
          <Text dimColor>
            {stats.requestCount} req{stats.requestCount !== 1 ? "s" : ""}
            {" · "}
            {formatTokenCount(stats.inputTokens)}↑{formatTokenCount(stats.outputTokens)}↓
          </Text>
        </>
      )}
    </Box>
  );
};

export const StatusBar = React.memo(StatusBarImpl);

// =============================================================================
// Helpers
// =============================================================================

function getPhaseLabel(
  phase: AppPhase,
  spinner: SpinnerStatus,
  glyphs: ReturnType<typeof getGlyphs>,
): string {
  switch (phase) {
    case "connecting":
      return `${glyphs.spinnerFrames[0]} Connecting...`;
    case "startup_error":
      return `${glyphs.cross} Error`;
    case "ready":
      return `${glyphs.checkmark} Ready`;
    case "running":
      return `${glyphs.spinnerFrames[0]} ${spinner ?? "Running"}...`;
    case "blocked":
      return `${glyphs.bullet} Waiting for input`;
    default:
      return phase;
  }
}
