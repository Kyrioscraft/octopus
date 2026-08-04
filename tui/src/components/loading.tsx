// =============================================================================
// Loading/spinner — blue spinner + status + elapsed timer.
//
//   ⠋ Thinking...  (3s, esc to interrupt)
// =============================================================================

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { SpinnerStatus } from "../types.js";
import { COLORS } from "../theme.js";

// =============================================================================
// Props
// =============================================================================

export interface LoadingProps {
  status?: SpinnerStatus;
  detail?: string;
}

// =============================================================================
// Component
// =============================================================================

const LoadingImpl: React.FC<LoadingProps> = ({ status, detail }) => {
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef(Date.now());

  // Reset timer when status changes (new turn starts)
  useEffect(() => {
    startTimeRef.current = Date.now();
    setElapsed(0);
  }, [status]);

  // Tick every second to update elapsed display
  useEffect(() => {
    if (!status) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (!status) return null;

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      <Box flexDirection="row">
        <Text color={COLORS.primary}>
          <Spinner type="dots" />
        </Text>
        <Text color={COLORS.primary}> {status}</Text>
        <Text dimColor> ({elapsed}s, esc to interrupt)</Text>
      </Box>
      {detail && (
        <Text dimColor>  {detail}</Text>
      )}
    </Box>
  );
};

// Memoize so the spinner's internal frame updates don't cause the parent
// (and thus MessageList) to re-render.
export const Loading = React.memo(LoadingImpl);
