// =============================================================================
// Theme selector screen — pick a color theme.
// Equivalent to Python tui.widgets.theme_selector.
// =============================================================================

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Available themes
// =============================================================================

const THEMES = [
  { name: "dark", label: "Dark (default)" },
  { name: "light", label: "Light" },
  { name: "system", label: "System" },
];

// =============================================================================
// Props
// =============================================================================

export interface ThemeSelectorProps {
  onSelect: (theme: string) => void;
  onDismiss: () => void;
  currentTheme?: string;
}

// =============================================================================
// Component
// =============================================================================

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({
  onSelect,
  onDismiss,
  currentTheme,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(() => {
    if (currentTheme) {
      const idx = THEMES.findIndex((t) => t.name === currentTheme);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  });

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((_input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? THEMES.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= THEMES.length - 1 ? 0 : prev + 1));
      return;
    }

    if (key.return) {
      const selected = THEMES[selectedIdx];
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
      <Box flexDirection="column" marginBottom={1}>
        {THEMES.map((theme, i) => {
          const isSelected = i === selectedIdx;
          const isCurrent = theme.name === currentTheme;
          return (
            <Box key={theme.name}>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? `${glyphs.arrow} ` : "  "}
                {theme.label}
              </Text>
              {isCurrent && (
                <Text color="green"> {glyphs.checkmark} active</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
