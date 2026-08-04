// =============================================================================
// useServerConnection — server connection lifecycle management.
//
// Extracted from app.tsx. Manages the phase transitions (connecting →
// ready | startup_error), the TuiClient instance, and the workspace binding.
// The refs (clientRef, workspaceIdRef, phaseRef) are created by the caller
// (app.tsx) so they can be shared with useChatSession without circular deps.
// =============================================================================

import { useState, useRef, useCallback } from "react";
import { cwd as processCwd } from "node:process";
import type { AppPhase } from "../types.js";
import { TuiClient } from "../client.js";
import { getLogger } from "../logging.js";

const logger = getLogger("tui.hooks.connection");

// =============================================================================
// Types
// =============================================================================

export interface UseServerConnectionOptions {
  serverUrl: string;
  token?: string;
  /** Skip auto-connect and boot straight into error screen. */
  initialError?: string;
  /** Current effective model spec (provider:model). */
  effectiveModel: string | null;
  /** Setter for the effective model. */
  setEffectiveModel: (model: string | null) => void;
  /** Setter for the agent's working directory (updated when workspace opens). */
  setAgentCwd: (cwd: string | null) => void;
  /** Shared ref — set to the TuiClient instance on successful connect. */
  clientRef: React.MutableRefObject<TuiClient | null>;
  /** Shared ref — set to the workspace ID on successful openWorkspace. */
  workspaceIdRef: React.MutableRefObject<string | null>;
  /** Shared ref — tracks the current phase for async callbacks. */
  phaseRef: React.MutableRefObject<AppPhase>;
  /** State setter for phase. */
  setPhase: (phase: AppPhase) => void;
}

export interface UseServerConnectionReturn {
  phase: AppPhase;
  serverError: string | null;
  setServerError: (err: string | null) => void;
  /** Call once on mount to connect. Pass an optional callback that runs after
   *  the connection succeeds (before the initial prompt is submitted). */
  initializeConnection: (onReady?: (client: TuiClient) => Promise<void>) => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

export function useServerConnection(
  opts: UseServerConnectionOptions,
): UseServerConnectionReturn {
  const {
    serverUrl, token, initialError,
    effectiveModel, setEffectiveModel, setAgentCwd,
    clientRef, workspaceIdRef, phaseRef, setPhase: setAppPhase,
  } = opts;

  const [phase, setPhaseState] = useState<AppPhase>(
    initialError ? "startup_error" : "connecting",
  );
  const [serverError, setServerError] = useState<string | null>(initialError ?? null);

  // Keep phaseRef in sync with phase state
  phaseRef.current = phase;

  // Override setPhase to sync both the hook's local state and the app's state
  const setPhaseSynced = useCallback((p: AppPhase) => {
    setPhaseState(p);
    setAppPhase(p);
    phaseRef.current = p;
  }, [phaseRef, setAppPhase]);

  // Post-connection callback — stored in a ref so initializeConnection's
  // dependency array doesn't need to list it (it may capture state from
  // other hooks that change on every render).
  const onReadyRef = useRef<((client: TuiClient) => Promise<void>) | undefined>(undefined);

  const initializeConnection = useCallback(async (
    onReady?: (client: TuiClient) => Promise<void>,
  ): Promise<void> => {
    onReadyRef.current = onReady;
    setPhaseSynced("connecting");
    setServerError(null);

    // Resolve the effective model: CLI flag > config.json default > hardcoded
    let resolvedModel = effectiveModel;
    if (!resolvedModel) {
      try {
        const { ModelConfig } = await import("@octopus/core");
        const config = ModelConfig.load();
        resolvedModel = config.default_model ?? null;
      } catch (err) {
        logger.warn("Failed to load model config", err);
      }
    }
    if (resolvedModel && resolvedModel !== effectiveModel) {
      setEffectiveModel(resolvedModel);
    }

    // Verify the model has credentials (non-blocking: error surfaces at runtime)
    if (resolvedModel) {
      try {
        const { ModelConfig } = await import("@octopus/core");
        const colonIdx = resolvedModel.indexOf(":");
        if (colonIdx > 0) {
          const provider = resolvedModel.slice(0, colonIdx);
          const apiKey = ModelConfig.getApiKey(provider);
          if (!apiKey) {
            logger.warn(
              `No API key found for "${provider}". ` +
              `Use /auth to configure one, or check ~/.deepagents/config.json.`,
            );
          }
        }
      } catch (err) {
        logger.warn("Model credential verification skipped", err);
      }
    }

    try {
      const client = new TuiClient({ baseUrl: serverUrl, token });
      clientRef.current = client;

      const health = await client.checkHealth();
      if (!health.ok) {
        setServerError(health.error ?? `Cannot connect to server at ${serverUrl}`);
        setPhaseSynced("startup_error");
        return;
      }

      setPhaseSynced("ready");

      // Open the TUI's launch directory as the agent's workspace.
      try {
        const launchDir = processCwd();
        const ws = await client.client.openWorkspace(launchDir);
        workspaceIdRef.current = ws.id;
        setAgentCwd(ws.path ?? launchDir);
      } catch (err) {
        logger.debug("openWorkspace failed; using server default", err);
      }

      // Run post-connection setup (load commands, restore history, etc.)
      if (onReadyRef.current) {
        await onReadyRef.current(client);
      }
    } catch (err) {
      logger.exception("Server connection failed", err);
      setServerError(`Cannot connect to server at ${serverUrl}: ${(err as Error).message}`);
      setPhaseSynced("startup_error");
    }
  }, [serverUrl, token, effectiveModel, setEffectiveModel, setAgentCwd, clientRef, workspaceIdRef, setPhaseSynced]);

  return {
    phase,
    serverError,
    setServerError,
    initializeConnection,
  };
}
