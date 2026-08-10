// =============================================================================
// MCP server viewer — display MCP server statuses.
// Equivalent to Python tui.widgets.mcp_viewer.
//
// Data is injected via props (from the server's listMcp endpoint via tentacle),
// which provides live connection status, rather than reading the local config
// file.
// =============================================================================

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../terminal/config-ui.js";

// =============================================================================
// Types
// =============================================================================

export interface McpServerEntry {
  name: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
}

// =============================================================================
// Props
// =============================================================================

export interface McpViewerProps {
  onDismiss: () => void;
  /** MCP server entries, injected by the parent (from the server). */
  servers: McpServerEntry[];
}

// =============================================================================
// Component
// =============================================================================

export const McpViewer: React.FC<McpViewerProps> = ({ onDismiss, servers }) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((_input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? Math.max(0, servers.length - 1) : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= Math.max(0, servers.length - 1) ? 0 : prev + 1));
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box flexDirection="column">
      {servers.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No MCP servers configured.</Text>
          <Text dimColor> Add servers to ~/.deepagents/.mcp.json or project .mcp.json</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {servers.map((srv, i) => {
            const isSelected = i === selectedIdx;
            const statusIcon = srv.connected
              ? glyphs.checkmark
              : srv.enabled
                ? glyphs.spinnerFrames[0]
                : glyphs.cross;
            const statusColor = srv.connected
              ? "green"
              : srv.enabled
                ? "yellow"
                : "red";
            const statusLabel = srv.connected
              ? "connected"
              : srv.enabled
                ? "enabled"
                : "disabled";
            return (
              <Box key={srv.name} flexDirection="column">
                <Box>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? `${glyphs.arrow} ` : "  "}
                    {srv.name}
                  </Text>
                  <Text dimColor> — {srv.transport}</Text>
                  <Text color={statusColor}> [{statusLabel}]</Text>
                  {srv.toolCount > 0 && (
                    <Text dimColor> · {srv.toolCount} tools</Text>
                  )}
                </Box>
                {srv.error && (
                  <Box paddingLeft={4}>
                    <Text color="red">{srv.error}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
};
