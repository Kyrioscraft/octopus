// =============================================================================
// LazyModal — generic load-on-mount wrapper for selector modals.
//
// Replaces ModelSelectorEffect, AgentSelectorEffect, and McpViewerEffect
// (three near-identical components from app.tsx). Triggers data loading via
// useEffect on first render and shows a loading indicator until data arrives.
// =============================================================================

import React, { useEffect } from "react";
import { Box, Text } from "ink";

// =============================================================================
// Types
// =============================================================================

export interface LazyModalProps<T> {
  /** The data array (empty until loaded). */
  data: T[];
  /** Whether data is currently being fetched. */
  loading: boolean;
  /** Human-readable loading text (e.g. "Loading models..."). */
  loadingText: string;
  /** Async function that fetches the data. Called on mount if data is empty. */
  onLoad: () => Promise<void>;
  /** Render prop — receives the data array once loaded. */
  children: (data: T[]) => React.ReactNode;
}

// =============================================================================
// Component
// =============================================================================

export function LazyModal<T>({
  data, loading, loadingText, onLoad, children,
}: LazyModalProps<T>): React.ReactNode {
  useEffect(() => {
    if (data.length === 0 && !loading) {
      onLoad();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && data.length === 0) {
    return (
      <Box marginY={1}>
        <Text dimColor>{loadingText}</Text>
      </Box>
    );
  }

  return <>{children(data)}</>;
}
