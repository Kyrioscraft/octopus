// =============================================================================
// Welcome screen — shown when the agent is idle with no messages.
// Tech-styled with a gradient "OCTOPUS" ASCII-art logo and a dashboard
// displaying the current model, agent, and server endpoint.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Props
// =============================================================================

export interface WelcomeScreenProps {
  model: string | null;
  agentName: string;
  serverUrl: string;
  /** Terminal column count — when too narrow for the ASCII logo, a compact
   *  text banner is rendered instead to avoid horizontal overflow. */
  columns?: number;
}

// Minimum columns required to render the full 63-col ASCII logo comfortably.
const LOGO_MIN_COLUMNS = 66;

// =============================================================================
// "OCTOPUS" ASCII-art logo (5 rows × ~55 cols, block characters)
// =============================================================================

const OCTOPUS_LOGO: string[] = [
  " ██████   ██████  ████████  ██████  ███████  ██    ██  ██████  ",
  "██    ██ ██          ██    ██    ██ ██    ██ ██    ██ ██       ",
  "██    ██ ██          ██    ██    ██ ███████  ██    ██  ██████  ",
  "██    ██ ██          ██    ██    ██ ██       ██    ██       ██ ",
  " ██████   ██████     ██     ██████  ██        ██████   ██████  ",
];

// Letters in order: O  C  T  O  P  U  S
// Each letter is ~7 cols wide, with a 1-col gap.
const LETTER_COLORS: string[] = [
  "#00d4ff", "#00aaff", "#0080ff", "#5555ff",
  "#7733ee", "#9911dd", "#aa00cc",
];

// =============================================================================
// Component
// =============================================================================

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  model,
  agentName,
  serverUrl,
  columns,
}) => {
  const glyphs = getGlyphs();
  const showLogo = (columns ?? 80) >= LOGO_MIN_COLUMNS;

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      {/* Spacer */}
      <Box height={2} />

      {/* Gradient-colored OCTOPUS logo — only when the terminal is wide enough;
          otherwise fall back to a compact text banner to avoid overflow. */}
      {showLogo ? (
        <Box flexDirection="column">
          {OCTOPUS_LOGO.map((line, i) => (
            <LogoLine key={i} line={line} />
          ))}
        </Box>
      ) : (
        <Box marginY={1}>
          <Text bold color="#00d4ff">
            {"░ "}OCTOPUS{" ░"}
          </Text>
        </Box>
      )}

      {/* Banner */}
      <Box marginY={1}>
        <Text bold color="#00d4ff">
          Octopus AI Agent
        </Text>
      </Box>

      {/* Divider */}
      <Box marginY={1}>
        <Text dimColor>
          {glyphs.boxHorizontal.repeat(20)}   {glyphs.spinnerFrames[0]}   {glyphs.boxHorizontal.repeat(20)}
        </Text>
      </Box>

      {/* Dashboard info */}
      <Box flexDirection="column">
        <InfoRow label="model" value={model ?? "—"} />
        <InfoRow label="agent" value={`@${agentName}`} />
        <InfoRow label="endpoint" value={serverUrl} />
      </Box>

      {/* Divider */}
      <Box marginY={1}>
        <Text dimColor>
          {glyphs.boxHorizontal.repeat(20)}   {glyphs.spinnerFrames[0]}   {glyphs.boxHorizontal.repeat(20)}
        </Text>
      </Box>

      {/* Footer hint */}
      <Box>
        <Text dimColor>
          Type a message to start  {" "}
        </Text>
        <Text dimColor>{glyphs.boxVertical}</Text>
        <Text dimColor>  Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
};

// =============================================================================
// Helpers
// =============================================================================

/** Render one line of the OCTOPUS logo with per-letter gradient colours. */
const LogoLine: React.FC<{ line: string }> = ({ line }) => {
  // Each letter block is 7 chars wide, and there's 1 space between letters.
  // The first char of O is at index 1, C at 9, T at 17, etc.
  const letterWidth = 9; // 7-col letter + 2-col gap (but our line has 1-col gap between)
  return (
    <Box>
      {LETTER_COLORS.map((color, i) => {
        const start = i * letterWidth;
        const chunk = line.slice(start, start + letterWidth);
        return (
          <Text key={i} color={color}>
            {chunk}
          </Text>
        );
      })}
    </Box>
  );
};

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box flexDirection="row">
    <Text color="cyan">  {">"} </Text>
    <Text color="cyan" dimColor>{label.padEnd(10)}</Text>
    <Text dimColor>{value}</Text>
  </Box>
);
