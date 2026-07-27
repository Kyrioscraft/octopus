// =============================================================================
// Model selector screen — list available models with auth status.
// Equivalent to Python tui.widgets.model_selector.
// =============================================================================

import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";
import { ModelConfig } from "@octopus/core";

// =============================================================================
// Props
// =============================================================================

export interface ModelSelectorProps {
  onSelect: (modelSpec: string) => void;
  onDismiss: () => void;
  currentModel?: string | null;
}

// =============================================================================
// Component
// =============================================================================

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  onSelect,
  onDismiss,
  currentModel,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Load available models from config
  const models = useMemo(() => {
    try {
      const config = ModelConfig.load();
      const entries: { spec: string; provider: string; model: string }[] = [];
      for (const [provider, providerConfig] of Object.entries(config.providers)) {
        const modelsList = providerConfig.models ?? [];
        for (const modelName of modelsList) {
          entries.push({
            spec: `${provider}:${modelName}`,
            provider,
            model: modelName,
          });
        }
      }
      return entries;
    } catch {
      return [];
    }
  }, []);

  // Set initial selection to current model
  React.useEffect(() => {
    if (currentModel) {
      const idx = models.findIndex((m) => m.spec === currentModel);
      if (idx >= 0) setSelectedIdx(idx);
    }
  }, [currentModel, models]);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? models.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= models.length - 1 ? 0 : prev + 1));
      return;
    }

    if (key.return) {
      const selected = models[selectedIdx];
      if (selected) {
        onSelect(selected.spec);
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
        <Text bold>Select Model {glyphs.toolPrefix}</Text>
      </Box>

      {models.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No models configured. Add providers in ~/.deepagents/config.json</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {models.map((model, i) => {
            const isSelected = i === selectedIdx;
            const isCurrent = model.spec === currentModel;
            return (
              <Box key={model.spec}>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? `${glyphs.arrow} ` : "  "}
                  {model.spec}
                </Text>
                {isCurrent && (
                  <Text color="green"> {glyphs.checkmark} active</Text>
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
