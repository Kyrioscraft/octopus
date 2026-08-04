// =============================================================================
// Modal overlay — unified full-screen container for all selector modals.
//
// All modal screens (ModelSelector, AgentSelector, ThemeSelector, AuthManager,
// McpViewer, NotificationCenter, ThreadSelector) render inside this wrapper so
// they share a consistent visual frame: a branded title bar, a bordered content
// region, and a dismiss hint at the bottom.
//
// In Ink there is no true z-index, so "overlay" is achieved by conditionally
// rendering this Box in place of the normal chrome region (see app.tsx's modal
// branch). It occupies the full body height via flexGrow.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import { COLORS, BORDERS, NAV_HINT } from "../theme.js";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Props
// =============================================================================

export interface ModalOverlayProps {
  /** Title shown in the header bar (e.g. "Select Model"). */
  title: string;
  /** Optional subtitle / context line. */
  subtitle?: string;
  /** The modal content. */
  children: React.ReactNode;
  /** Hint text for the footer (defaults to the standard nav hint). */
  hint?: string;
}

// =============================================================================
// Component
// =============================================================================

export const ModalOverlay: React.FC<ModalOverlayProps> = ({
  title,
  subtitle,
  children,
  hint,
}) => {
  const glyphs = getGlyphs();

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      borderStyle={BORDERS.panel}
      borderColor={COLORS.primary}
    >
      {/* Title bar */}
      <Box flexShrink={0} paddingX={1}>
        <Text backgroundColor={COLORS.primary} color="black">
          {" "}
          {glyphs.bullet} {title}{" "}
        </Text>
        {subtitle && (
          <Text dimColor> {subtitle}</Text>
        )}
      </Box>

      {/* Content region — scrollable content lives here */}
      <Box flexDirection="column" flexGrow={1} minHeight={0} paddingX={1} paddingY={0}>
        {children}
      </Box>

      {/* Footer hint */}
      <Box flexShrink={0} paddingX={1}>
        <Text dimColor>{glyphs.bullet} {hint ?? NAV_HINT}</Text>
      </Box>
    </Box>
  );
};
