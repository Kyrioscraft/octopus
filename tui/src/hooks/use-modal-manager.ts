// =============================================================================
// useModalManager — modal state management and on-demand data loading.
//
// Extracted from app.tsx. Manages which modal is open, cached data for each
// modal type (models, agents, MCP servers), and lazy-loading functions.
// =============================================================================

import { useState, useCallback } from "react";
import { TuiClient } from "../client/client.js";
import type { ModelEntry } from "../components/model-selector.js";
import type { McpServerEntry } from "../components/mcp-viewer.js";
import { getLogger } from "../utils/logging.js";

const logger = getLogger("tui.hooks.modal");

// =============================================================================
// Types
// =============================================================================

export type ModalName = "model" | "agents" | "threads" | "theme" | "auth" | "mcp" | "notifications";

export interface UseModalManagerDeps {
  clientRef: React.MutableRefObject<TuiClient | null>;
}

export interface UseModalManagerReturn {
  activeModal: ModalName | null;
  setActiveModal: (name: ModalName | null) => void;
  openModal: (name: ModalName) => void;
  closeModal: () => void;
  /** Cached model list for the ModelSelector. */
  modalModels: ModelEntry[];
  /** Cached subagent list for the AgentSelector. */
  modalAgents: { name: string; description: string }[];
  /** Cached MCP server statuses for the McpViewer. */
  modalMcpServers: McpServerEntry[];
  /** Whether a modal's data is currently being fetched. */
  modalLoading: boolean;
  /** Fetch model list from the server. */
  loadModalModels: () => Promise<void>;
  /** Fetch subagent list from the server. */
  loadModalAgents: () => Promise<void>;
  /** Fetch MCP server statuses from the server. */
  loadModalMcp: () => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

export function useModalManager(deps: UseModalManagerDeps): UseModalManagerReturn {
  const { clientRef } = deps;

  const [activeModal, setActiveModal] = useState<ModalName | null>(null);
  const [modalModels, setModalModels] = useState<ModelEntry[]>([]);
  const [modalAgents, setModalAgents] = useState<{ name: string; description: string }[]>([]);
  const [modalMcpServers, setModalMcpServers] = useState<McpServerEntry[]>([]);
  const [modalLoading, setModalLoading] = useState(false);

  const openModal = useCallback((name: ModalName) => {
    setActiveModal(name);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
  }, []);

  const loadModalModels = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    setModalLoading(true);
    try {
      const settings = await client.client.listModelSettings();
      const entries: ModelEntry[] = [];
      for (const provider of settings.providers) {
        if (!provider.enabled) continue;
        for (const model of provider.models) {
          entries.push({ spec: `${provider.name}:${model}`, provider: provider.name, model });
        }
      }
      setModalModels(entries);
    } catch (err) {
      logger.exception("Failed to load models for selector", err);
      setModalModels([]);
    } finally {
      setModalLoading(false);
    }
  }, []);

  const loadModalAgents = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    setModalLoading(true);
    try {
      const entries = await client.client.listSubagents();
      setModalAgents(entries.filter((a) => a.enabled).map((a) => ({
        name: a.name,
        description: a.description,
      })));
    } catch (err) {
      logger.exception("Failed to load subagents for selector", err);
      setModalAgents([]);
    } finally {
      setModalLoading(false);
    }
  }, []);

  const loadModalMcp = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    setModalLoading(true);
    try {
      const entries = await client.client.listMcp(true);
      setModalMcpServers(entries.map((e) => ({
        name: e.name,
        transport: e.transport,
        enabled: e.enabled,
        connected: e.status === "ok",
        toolCount: 0,
        error: e.error,
      })));
    } catch (err) {
      logger.exception("Failed to load MCP servers for viewer", err);
      setModalMcpServers([]);
    } finally {
      setModalLoading(false);
    }
  }, []);

  return {
    activeModal, setActiveModal,
    openModal, closeModal,
    modalModels, modalAgents, modalMcpServers,
    modalLoading,
    loadModalModels, loadModalAgents, loadModalMcp,
  };
}
