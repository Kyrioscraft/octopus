// =============================================================================
// Agent selector screen — list available agents/subagents.
// Equivalent to Python tui.widgets.agent_selector.
// =============================================================================

import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Props
// =============================================================================

export interface AgentSelectorProps {
  onSelect: (agentName: string) => void;
  onDismiss: () => void;
  currentAgent?: string;
}

// =============================================================================
// Component
// =============================================================================

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  onSelect,
  onDismiss,
  currentAgent,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [agents, setAgents] = useState<{ name: string; description: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAgents() {
      try {
        const { listSubagents } = await import("@octopus/core");
        const result = listSubagents({});
        setAgents(result);
      } catch {
        setAgents([]);
      }
      setLoading(false);
    }
    loadAgents();
  }, []);

  // Set initial selection to current agent
  useEffect(() => {
    if (currentAgent) {
      const idx = agents.findIndex((a) => a.name === currentAgent);
      if (idx >= 0) setSelectedIdx(idx);
    }
  }, [currentAgent, agents]);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? agents.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= agents.length - 1 ? 0 : prev + 1));
      return;
    }

    if (key.return) {
      const selected = agents[selectedIdx];
      if (selected) {
        onSelect(selected.name);
      }
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Select Agent {glyphs.toolPrefix}</Text>
      </Box>

      {loading ? (
        <Box marginY={1}>
          <Text dimColor>Loading agents...</Text>
        </Box>
      ) : agents.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No agents found. Create AGENTS.md files to add agents.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {agents.map((agent, i) => {
            const isSelected = i === selectedIdx;
            const isCurrent = agent.name === currentAgent;
            return (
              <Box key={agent.name} flexDirection="column">
                <Box>
                  <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {isSelected ? `${glyphs.arrow} ` : "  "}
                    {agent.name}
                  </Text>
                  {isCurrent && (
                    <Text color="green"> {glyphs.checkmark} active</Text>
                  )}
                </Box>
                {agent.description && (
                  <Box paddingLeft={4}>
                    <Text dimColor>{agent.description}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box>
        <Text dimColor>
          {glyphs.bullet} ↑↓ to navigate, Enter to select, Esc to dismiss
        </Text>
      </Box>
    </Box>
  );
};
