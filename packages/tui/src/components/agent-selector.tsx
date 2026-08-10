// =============================================================================
// Agent selector screen — list available agents/subagents.
// Equivalent to Python tui.widgets.agent_selector.
//
// Data is injected via props (from the server's listSubagents endpoint via
// tentacle), rather than calling @octopus/core directly.
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../terminal/config-ui.js";

// =============================================================================
// Props
// =============================================================================

export interface AgentSelectorProps {
  onSelect: (agentName: string) => void;
  onDismiss: () => void;
  currentAgent?: string;
  /** Available agents, injected by the parent (from the server). */
  agents: { name: string; description: string }[];
}

// =============================================================================
// Component
// =============================================================================

export const AgentSelector: React.FC<AgentSelectorProps> = ({
  onSelect,
  onDismiss,
  currentAgent,
  agents,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);

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
  useInput((_input, key) => {
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
    <Box flexDirection="column">
      {agents.length === 0 ? (
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
    </Box>
  );
};
