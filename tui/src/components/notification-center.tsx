// =============================================================================
// Notification center — display actionable notifications.
// Equivalent to Python tui.widgets.notification_center.
// =============================================================================

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";

// =============================================================================
// Notification type
// =============================================================================

interface Notification {
  key: string;
  title: string;
  body: string;
  actions: { actionId: string; label: string; primary?: boolean }[];
}

// =============================================================================
// Props
// =============================================================================

export interface NotificationCenterProps {
  onDismiss: () => void;
  notifications?: Notification[];
}

// =============================================================================
// Component
// =============================================================================

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  onDismiss,
  notifications = [],
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((_input, key) => {
    if (key.escape) {
      onDismiss();
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? Math.max(0, notifications.length - 1) : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= Math.max(0, notifications.length - 1) ? 0 : prev + 1));
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Notifications {glyphs.toolPrefix}</Text>
      </Box>

      {notifications.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No notifications.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {notifications.map((notif, i) => {
            const isSelected = i === selectedIdx;
            return (
              <Box key={notif.key} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color={isSelected ? "cyan" : undefined} bold>
                    {isSelected ? `${glyphs.arrow} ` : "  "}
                    {notif.title}
                  </Text>
                </Box>
                <Box paddingLeft={4}>
                  <Text dimColor>{notif.body}</Text>
                </Box>
                {notif.actions.length > 0 && (
                  <Box paddingLeft={4}>
                    <Text dimColor>
                      Actions: {notif.actions.map((a) => a.label).join(", ")}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box>
        <Text dimColor>
          {glyphs.bullet} ↑↓ to navigate, Esc to dismiss
        </Text>
      </Box>
    </Box>
  );
};
