// =============================================================================
// Loading/spinner component — animated status indicator.
// Equivalent to Python tui.widgets.loading.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SpinnerStatus } from "../types.js";

// =============================================================================
// Props
// =============================================================================

export interface LoadingProps {
  /** Status text to display alongside the spinner. */
  status?: SpinnerStatus;
  /** Additional detail text below the status. */
  detail?: string;
}

// =============================================================================
// Component
// =============================================================================

const LoadingImpl: React.FC<LoadingProps> = ({ status, detail }) => {
  if (!status) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="row">
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
        <Text color="yellow"> {status}</Text>
      </Box>
      {detail && (
        <Box marginLeft={2}>
          <Text dimColor>{detail}</Text>
        </Box>
      )}
    </Box>
  );
};

// Memoize so the spinner's internal frame updates don't cause the parent
// (and thus MessageList) to re-render.
export const Loading = React.memo(LoadingImpl);
