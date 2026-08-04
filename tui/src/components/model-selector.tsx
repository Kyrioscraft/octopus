// =============================================================================
// Model selector screen — list available models with auth status.
// Equivalent to Python tui.widgets.model_selector.
//
// Data is injected via props (from the server's listModelSettings endpoint via
// tentacle), rather than reading the local config file directly. This keeps
// the TUI consistent with the web client's view of available models.
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Types
// =============================================================================

export interface ModelEntry {
  /** Full model spec, e.g. "anthropic:claude-sonnet-4-6". */
  spec: string;
  provider: string;
  model: string;
}

// =============================================================================
// Props
// =============================================================================

export interface ModelSelectorProps {
  onSelect: (modelSpec: string) => void;
  onDismiss: () => void;
  currentModel?: string | null;
  /** Available models, injected by the parent (from the server). */
  models: ModelEntry[];
}

// =============================================================================
// Component
// =============================================================================

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  onSelect,
  onDismiss,
  currentModel,
  models,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Set initial selection to current model
  useEffect(() => {
    if (currentModel) {
      const idx = models.findIndex((m) => m.spec === currentModel);
      if (idx >= 0) setSelectedIdx(idx);
    }
  }, [currentModel, models]);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((_input, key) => {
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
    <Box flexDirection="column">
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
    </Box>
  );
};
