// =============================================================================
// MCP server viewer — display MCP server statuses.
// Equivalent to Python tui.widgets.mcp_viewer.
// =============================================================================

import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// MCP server status type
// =============================================================================

interface McpServerEntry {
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
}

// =============================================================================
// Component
// =============================================================================

export const McpViewer: React.FC<McpViewerProps> = ({ onDismiss }) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { loadMcpConfig, DEFAULT_CONFIG_PATH } = await import("@octopus/core");
        const config = loadMcpConfig(DEFAULT_CONFIG_PATH);
        const entries: McpServerEntry[] = [];
        if (config && config.servers) {
          for (const [name, server] of Object.entries(config.servers)) {
            const srv = server as Record<string, unknown>;
            entries.push({
              name,
              transport: (srv.transport as string) ?? (srv.type as string) ?? "stdio",
              enabled: !(srv.disabled as boolean),
              connected: false,
              toolCount: 0,
            });
          }
        }
        setServers(entries);
      } catch {
        setServers([]);
      }
      setLoading(false);
    }
    load();
  }, []);

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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>MCP Servers {glyphs.toolPrefix}</Text>
      </Box>

      {loading ? (
        <Box marginY={1}>
          <Text dimColor>Loading MCP config...</Text>
        </Box>
      ) : servers.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No MCP servers configured.</Text>
          <Text dimColor> Add servers to ~/.deepagents/.mcp.json or project .mcp.json</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {servers.map((srv, i) => {
            const isSelected = i === selectedIdx;
            const statusIcon = srv.enabled ? glyphs.checkmark : glyphs.cross;
            const statusColor = srv.enabled ? "green" : "red";
            const statusLabel = srv.enabled ? "enabled" : "disabled";
            return (
              <Box key={srv.name} flexDirection="column">
                <Box>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? `${glyphs.arrow} ` : "  "}
                    {srv.name}
                  </Text>
                  <Text dimColor> — {srv.transport}</Text>
                  <Text color={statusColor}> [{statusLabel}]</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      <Box>
        <Text dimColor>
          {glyphs.bullet + " ↑↓ to navigate, Esc to dismiss. Use /mcp login <server> to authenticate."}
        </Text>
      </Box>
    </Box>
  );
};
