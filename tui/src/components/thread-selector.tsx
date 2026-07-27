// =============================================================================
// Thread/chat history selector — list previous threads with search.
// Equivalent to Python tui.widgets.thread_selector.
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";
import { formatRelativeTimestamp } from "../formatting.js";
import type { TuiClient } from "../client.js";
import type { ThreadInfo } from "../sessions.js";
import { listThreads } from "../sessions.js";

// =============================================================================
// Props
// =============================================================================

export interface ThreadSelectorProps {
  client: TuiClient | null;
  onSelect: (threadId: string) => void;
  onDismiss: () => void;
  currentThreadId?: string | null;
}

// =============================================================================
// Component
// =============================================================================

export const ThreadSelector: React.FC<ThreadSelectorProps> = ({
  client,
  onSelect,
  onDismiss,
  currentThreadId,
}) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function load() {
      if (!client) {
        setError("No server connection");
        setLoading(false);
        return;
      }
      try {
        const result = await listThreads(client);
        setThreads(result);
      } catch (err) {
        setError((err as Error).message);
      }
      setLoading(false);
    }
    load();
  }, [client]);

  // Filter by search
  const filtered = search
    ? threads.filter(
        (t) =>
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          t.id.toLowerCase().includes(search.toLowerCase())
      )
    : threads;

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape) {
      if (search) {
        setSearch("");
        return;
      }
      onDismiss();
      return;
    }

    if (search) {
      // Search input mode
      if (key.return) {
        if (filtered.length > 0) {
          onSelect(filtered[0].id);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((prev) => prev.slice(0, -1));
        return;
      }
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        setSearch((prev) => prev + input);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? Math.max(0, filtered.length - 1) : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= filtered.length - 1 ? 0 : prev + 1));
      return;
    }

    if (key.return) {
      const selected = filtered[selectedIdx];
      if (selected) {
        onSelect(selected.id);
      }
      return;
    }

    // Type to search
    if (input === "/") {
      setSearch("/");
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>Threads {glyphs.toolPrefix}</Text>
        {!search && (
          <Text dimColor> (type / to search)</Text>
        )}
      </Box>

      {/* Search bar */}
      {search && (
        <Box marginBottom={1}>
          <Text dimColor>Search: </Text>
          <Text>{search}</Text>
          <Text dimColor>█</Text>
        </Box>
      )}

      {loading ? (
        <Box marginY={1}>
          <Text dimColor>Loading threads...</Text>
        </Box>
      ) : error ? (
        <Box marginY={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : filtered.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>
            {search ? "No matching threads." : "No threads yet. Start a conversation!"}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {filtered.map((thread, i) => {
            const isSelected = i === selectedIdx;
            const isCurrent = thread.id === currentThreadId;
            return (
              <Box key={thread.id}>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? `${glyphs.arrow} ` : "  "}
                  {thread.title || "(untitled)"}
                </Text>
                <Text dimColor> — {thread.relativeTime}</Text>
                {isCurrent && (
                  <Text color="green"> {glyphs.checkmark}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box>
        <Text dimColor>
          {search
            ? `${glyphs.bullet} Enter to select first match, Esc to clear search`
            : `${glyphs.bullet} ↑↓ to navigate, Enter to select, Esc to dismiss`}
        </Text>
      </Box>
    </Box>
  );
};
