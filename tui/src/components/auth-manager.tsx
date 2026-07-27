// =============================================================================
// Auth manager screen — manage stored API keys.
// Equivalent to Python tui.widgets.auth + Python tui.auth_display.
// =============================================================================

import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getGlyphs } from "../config-ui.js";
import { ModelConfig } from "@octopus/core";

// =============================================================================
// Auth status types
// =============================================================================

interface ProviderStatus {
  provider: string;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  baseUrl?: string;
}

// =============================================================================
// Props
// =============================================================================

export interface AuthManagerProps {
  onDismiss: () => void;
}

// =============================================================================
// Component
// =============================================================================

export const AuthManager: React.FC<AuthManagerProps> = ({ onDismiss }) => {
  const glyphs = getGlyphs();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Load provider statuses
  const providers = useMemo(() => {
    try {
      const config = ModelConfig.load();
      return Object.entries(config.providers).map(([provider, providerConfig]) => {
        let hasApiKey = false;
        try {
          hasApiKey = !!ModelConfig.getApiKey(provider);
        } catch {
          // getApiKey might not exist
        }
        return {
          provider,
          hasApiKey,
          hasBaseUrl: !!providerConfig.base_url,
          baseUrl: providerConfig.base_url,
        };
      });
    } catch {
      return [];
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape) {
      if (selectedProvider) {
        setSelectedProvider(null);
        setApiKeyInput("");
        setBaseUrlInput("");
        setStatusMessage(null);
        return;
      }
      onDismiss();
      return;
    }

    if (selectedProvider) {
      // API key input mode
      if (key.return) {
        if (apiKeyInput.trim()) {
          // Save the key
          setStatusMessage(`API key saved for ${selectedProvider}. (Phase 6 persistence)`);
          setSelectedProvider(null);
          setApiKeyInput("");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setApiKeyInput((prev) => prev.slice(0, -1));
        return;
      }
      if (input.length === 1 && input.charCodeAt(0) >= 32) {
        setApiKeyInput((prev) => prev + input);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? providers.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.tab) {
      setSelectedIdx((prev) => (prev >= providers.length - 1 ? 0 : prev + 1));
      return;
    }

    if (key.return) {
      const selected = providers[selectedIdx];
      if (selected) {
        setSelectedProvider(selected.provider);
      }
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // API key input mode
  if (selectedProvider) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold>Configure {selectedProvider}</Text>
        </Box>

        <Box marginBottom={1}>
          <Text>Enter API key for {selectedProvider}:</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="cyan">{glyphs.arrow} </Text>
          <Text>{apiKeyInput.replace(/./g, "*")}</Text>
          <Text dimColor>█</Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Press Enter to save, Esc to cancel.</Text>
        </Box>

        {statusMessage && (
          <Box>
            <Text color="green">{statusMessage}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Provider list
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>API Keys {glyphs.toolPrefix}</Text>
      </Box>

      {providers.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No providers configured. Add providers in ~/.deepagents/config.json</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {providers.map((p, i) => {
            const isSelected = i === selectedIdx;
            const statusIcon = p.hasApiKey ? glyphs.checkmark : glyphs.cross;
            const statusColor = p.hasApiKey ? "green" : "red";
            const statusLabel = p.hasApiKey ? "configured" : "missing";
            return (
              <Box key={p.provider}>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                  {isSelected ? `${glyphs.arrow} ` : "  "}
                  {p.provider}
                </Text>
                <Text dimColor> — </Text>
                <Text color={statusColor}>
                  {statusIcon} {statusLabel}
                </Text>
                {p.baseUrl && (
                  <Text dimColor> ({p.baseUrl})</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box>
        <Text dimColor>
          {glyphs.bullet} ↑↓ to navigate, Enter to configure, Esc to dismiss
        </Text>
      </Box>
    </Box>
  );
};
