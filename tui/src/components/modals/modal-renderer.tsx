// =============================================================================
// ModalRenderer — renders the appropriate modal component based on
// activeModal name. Extracted from the conditional-render chain in app.tsx.
// =============================================================================

import React from "react";
import { TuiClient } from "../../client/client.js";
import type { ModelEntry } from "../model-selector.js";
import type { McpServerEntry } from "../mcp-viewer.js";
import { ThreadSelector } from "../thread-selector.js";
import { ModelSelector } from "../model-selector.js";
import { AgentSelector } from "../agent-selector.js";
import { ThemeSelector } from "../theme-selector.js";
import { AuthManager } from "../auth-manager.js";
import { McpViewer } from "../mcp-viewer.js";
import { NotificationCenter } from "../notification-center.js";
import { ModalOverlay } from "../modal-overlay.js";
import { LazyModal } from "./lazy-modal.js";

// =============================================================================
// Types
// =============================================================================

export interface ModalRendererProps {
  activeModal: string | null;
  onClose: () => void;
  clientRef: React.MutableRefObject<TuiClient | null>;
  currentThreadId: string | null;
  onThreadSelect: (threadId: string) => Promise<void>;
  effectiveModel: string | null;
  agentName: string;

  // Lazy-loaded data
  modalModels: ModelEntry[];
  modalAgents: { name: string; description: string }[];
  modalMcpServers: McpServerEntry[];
  modalLoading: boolean;
  loadModalModels: () => Promise<void>;
  loadModalAgents: () => Promise<void>;
  loadModalMcp: () => Promise<void>;

  // Callbacks
  onModelSelect: (spec: string) => void;
  onAgentSelect: (name: string) => void;
  onThemeSelect: (theme: string) => void;
  onAuthDismiss: () => void;
}

// =============================================================================
// Component
// =============================================================================

export const ModalRenderer: React.FC<ModalRendererProps> = (props) => {
  const {
    activeModal, onClose,
    clientRef, currentThreadId, onThreadSelect,
    effectiveModel, agentName,
    modalModels, modalAgents, modalMcpServers, modalLoading,
    loadModalModels, loadModalAgents, loadModalMcp,
    onModelSelect, onAgentSelect, onThemeSelect, onAuthDismiss,
  } = props;

  if (!activeModal) return null;

  switch (activeModal) {
    case "threads":
      return (
        <ThreadSelector
          client={clientRef.current}
          currentThreadId={currentThreadId}
          onSelect={async (threadId) => {
            onClose();
            await onThreadSelect(threadId);
          }}
          onDismiss={onClose}
        />
      );

    case "model":
      return (
        <ModalOverlay title="Select Model" subtitle={effectiveModel ?? undefined}>
          <LazyModal
            data={modalModels}
            loading={modalLoading}
            loadingText="Loading models..."
            onLoad={loadModalModels}
          >
            {(models) => (
              <ModelSelector
                models={models}
                currentModel={effectiveModel}
                onSelect={onModelSelect}
                onDismiss={onClose}
              />
            )}
          </LazyModal>
        </ModalOverlay>
      );

    case "agents":
      return (
        <ModalOverlay title="Select Agent" subtitle={agentName || undefined}>
          <LazyModal
            data={modalAgents}
            loading={modalLoading}
            loadingText="Loading agents..."
            onLoad={loadModalAgents}
          >
            {(agents) => (
              <AgentSelector
                agents={agents}
                onSelect={onAgentSelect}
                onDismiss={onClose}
              />
            )}
          </LazyModal>
        </ModalOverlay>
      );

    case "theme":
      return (
        <ModalOverlay title="Select Theme">
          <ThemeSelector
            onSelect={onThemeSelect}
            onDismiss={onClose}
          />
        </ModalOverlay>
      );

    case "auth":
      return (
        <AuthManager onDismiss={onAuthDismiss} />
      );

    case "mcp":
      return (
        <ModalOverlay title="MCP Servers" subtitle="live connection status">
          <LazyModal
            data={modalMcpServers}
            loading={modalLoading}
            loadingText="Loading MCP servers..."
            onLoad={loadModalMcp}
          >
            {(servers) => (
              <McpViewer servers={servers} onDismiss={onClose} />
            )}
          </LazyModal>
        </ModalOverlay>
      );

    case "notifications":
      return (
        <ModalOverlay title="Notifications">
          <NotificationCenter onDismiss={onClose} />
        </ModalOverlay>
      );

    default:
      return null;
  }
};
