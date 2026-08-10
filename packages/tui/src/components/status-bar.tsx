// =============================================================================
// Status bar — bottom single-row.
//
// Layout:
//   [MODE] [auto]  ready  ~/path  #thread ── 12.3K tokens │ model
//
// Left: pills + status + cwd + thread (natural spacing)
// Right: tokens + model (│ separator)
// Flex-grow spacer between left info and right metrics.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { AppPhase, SpinnerStatus, SessionStats, InputMode } from "../types.js";
import { formatTokenCount } from "../utils/formatting.js";
import { getGlyphs } from "../terminal/config-ui.js";
import { useFrame } from "../terminal/use-frame.js";
import { COLORS } from "../terminal/theme.js";
import { homedir } from "node:os";
import { sep } from "node:path";

// =============================================================================
// Props
// =============================================================================

export interface StatusBarProps {
  model: string | null;
  threadId: string | null;
  phase: AppPhase;
  spinner: SpinnerStatus;
  stats: SessionStats;
  cwd?: string | null;
  inputMode?: InputMode;
  autoApprove?: boolean;
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
  cwd,
  inputMode,
  autoApprove,
}) => {
  const glyphs = getGlyphs();
  const frame = useFrame();
  const isBusy = phase === "running" || phase === "connecting";
  const showTokens = stats.requestCount > 0;

  return (
    <Box flexDirection="row">
      {/* Left: pills + status + cwd + thread */}
      <Box flexShrink={1}>
        {inputMode && inputMode !== "normal" && <ModePill mode={inputMode} />}
        <ApprovePill autoApprove={autoApprove ?? false} />
        {isBusy ? (
          <Text dimColor> {frame} {(spinner ?? "working").toLowerCase()}</Text>
        ) : (
          <Text dimColor> ready</Text>
        )}
        {cwd && <Text dimColor>  {shortenPath(cwd)}</Text>}
        {threadId && <Text dimColor>  #{threadId.slice(7, 15)}</Text>}
      </Box>

      {/* Spacer */}
      <Box flexGrow={1} />

      {/* Right: tokens + model */}
      {(showTokens || model) && (
        <Box flexShrink={0}>
          {showTokens && (
            <Text dimColor>{formatTokenCount(stats.inputTokens + stats.outputTokens)} tokens</Text>
          )}
          {showTokens && model && <Text dimColor> │ </Text>}
          {model && <Text dimColor>{model}</Text>}
        </Box>
      )}
    </Box>
  );
};

export const StatusBar = React.memo(StatusBarImpl);

// =============================================================================
// Pills
// =============================================================================

const ModePill: React.FC<{ mode: InputMode }> = ({ mode }) => {
  let label: string;
  let color: string;
  switch (mode) {
    case "shell":        label = "$ SHELL"; color = COLORS.error;      break;
    case "shell_incognito": label = "$ SHELL"; color = COLORS.incognito; break;
    default:             return null;
  }
  return <Text backgroundColor={color} color="black" bold> {label} </Text>;
};

const ApprovePill: React.FC<{ autoApprove: boolean }> = ({ autoApprove }) => (
  <Text backgroundColor={autoApprove ? COLORS.success : COLORS.warning} color="black" bold>
    {" "}{autoApprove ? "auto" : "manual"}{" "}
  </Text>
);

// =============================================================================
// Helpers
// =============================================================================

function shortenPath(p: string): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(home + sep))) {
    return "~" + p.slice(home.length);
  }
  return p;
}
