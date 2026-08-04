// =============================================================================
// Main Ink app component — thin orchestrator.
//
// This is the top-level React component rendered by Ink. It wires together
// the hooks (connection, chat, modals, commands) and renders the appropriate
// screen component based on the current connection phase.
//
// Refactored from a 1323-line monolithic component into a ~200-line
// orchestrator. Each subsystem lives in its own hook/module under hooks/,
// commands/, and components/screens/.
// =============================================================================

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useInput, useApp, useWindowSize } from "ink";
import type { AppPhase, InputMode, SessionStats } from "./types.js";
import { TuiClient } from "./client.js";
import {
  ALWAYS_IMMEDIATE, BYPASS_WHEN_CONNECTING, IMMEDIATE_UI, SIDE_EFFECT_FREE,
  STARTUP_RECOVERY_COMMANDS, parseSkillCommand,
} from "./command-registry.js";
import { useServerConnection } from "./hooks/use-server-connection.js";
import { useChatSession } from "./hooks/use-chat-session.js";
import { useModalManager } from "./hooks/use-modal-manager.js";
import { useCommandRegistry } from "./hooks/use-command-registry.js";
import { createDispatchCommand } from "./commands/dispatch.js";
import { ConnectingScreen } from "./components/screens/connecting-screen.js";
import { ErrorScreen } from "./components/screens/error-screen.js";
import { MainScreen } from "./components/screens/main-screen.js";
import { getLogFilePath, isDebugEnabled } from "./logging.js";

// =============================================================================
// Props
// =============================================================================

export interface AppProps {
  modelSpec?: string;
  initialPrompt?: string;
  agentName: string;
  autoApprove: boolean;
  enableShell: boolean;
  serverUrl: string;
  token?: string;
  /** Skip the "connecting" phase and boot straight into the error screen. */
  initialError?: string;
}

// =============================================================================
// App component
// =============================================================================

export const App: React.FC<AppProps> = (props) => {
  const { exit } = useApp();
  const { columns } = useWindowSize();

  // ---------------------------------------------------------------------------
  // App-level state (shared across hooks)
  // ---------------------------------------------------------------------------
  const [effectiveModel, setEffectiveModel] = useState<string | null>(
    props.modelSpec ?? null,
  );
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    requestCount: 0, inputTokens: 0, outputTokens: 0, wallTimeSeconds: 0, perModel: {},
  });
  const [showTimestamps, setShowTimestamps] = useState(false);

  // ---------------------------------------------------------------------------
  // Shared refs (used by both connection and chat hooks)
  // ---------------------------------------------------------------------------
  const clientRef = useRef<TuiClient | null>(null);
  const workspaceIdRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<AppPhase>(
    props.initialError ? "startup_error" : "connecting",
  );
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ---------------------------------------------------------------------------
  // Subsystem hooks
  // ---------------------------------------------------------------------------

  const chat = useChatSession({
    clientRef, workspaceIdRef, phaseRef, setPhase,
    agentName: props.agentName,
    autoApprove: props.autoApprove,
  });

  const connection = useServerConnection({
    serverUrl: props.serverUrl,
    token: props.token,
    initialError: props.initialError,
    effectiveModel,
    setEffectiveModel,
    setAgentCwd: chat.setAgentCwd,
    clientRef, workspaceIdRef, phaseRef, setPhase,
  });

  const modals = useModalManager({ clientRef });
  const commands = useCommandRegistry();

  // ---------------------------------------------------------------------------
  // Wire adapterCallbacks.updateStats (depends on app-level sessionStats)
  // ---------------------------------------------------------------------------
  // Created once via useEffect to avoid mutating ref during render
  useEffect(() => {
    chat.adapterCallbacks.current.updateStats = (stats) => {
      setSessionStats((prev) => ({
        ...prev, ...stats, perModel: { ...prev.perModel },
      }));
    };
  }, []);

  // ---------------------------------------------------------------------------
  // /log command helper
  // ---------------------------------------------------------------------------
  const showLogTail = useCallback(() => {
    const logPath = getLogFilePath();
    const enabled = isDebugEnabled();
    const lines: string[] = [];

    lines.push(`Debug logging: ${enabled ? "ON" : "OFF"}`);
    lines.push(`Log file: ${logPath}`);

    if (!enabled) {
      lines.push("Enable with: --debug flag or OCTOPUS_TUI_DEBUG=1 env var");
    }

    try {
      const { readFileSync, existsSync } = require("node:fs");
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, "utf-8") as string;
        const allLines = content.trimEnd().split("\n");
        const tail = allLines.slice(-15);
        if (tail.length > 0) {
          lines.push("");
          lines.push(`Last ${tail.length} line(s):`);
          for (const line of tail) {
            lines.push(`  ${line}`);
          }
        } else {
          lines.push("(log file is empty)");
        }
      } else {
        lines.push("(log file does not exist yet)");
      }
    } catch (err) {
      lines.push(`(failed to read log: ${(err as Error).message})`);
    }

    chat.addAppMessage(lines.join("\n"));
  }, [chat.addAppMessage]);

  // ---------------------------------------------------------------------------
  // Post-connection setup (shared between initial mount and /reload)
  // ---------------------------------------------------------------------------
  const onPostConnect = useCallback(async (client: TuiClient) => {
    commands.loadCommands(client);
    await chat.loadMostRecentThread();
  }, [commands.loadCommands, chat.loadMostRecentThread]);

  // ---------------------------------------------------------------------------
  // Command dispatch
  // ---------------------------------------------------------------------------
  const dispatch = createDispatchCommand({
    exit,
    addAppMessage: chat.addAppMessage,
    executeMessage: chat.executeMessage,
    setActiveModal: modals.setActiveModal as (name: string | null) => void,
    messages: chat.messages,
    setMessages: chat.setMessages,
    setCurrentThreadId: chat.setCurrentThreadId,
    setAgentCwd: chat.setAgentCwd,
    setMessageQueue: chat.setMessageQueue,
    setSpinnerStatus: chat.setSpinnerStatus,
    setPhase,
    setServerError: connection.setServerError,
    showTimestamps,
    setShowTimestamps,
    sessionStats,
    commandIndex: commands.commandIndex,
    reconnect: () => { connection.initializeConnection(onPostConnect); },
    showLogTail,
  });

  // ---------------------------------------------------------------------------
  // Input submission — entry point for all user input
  // ---------------------------------------------------------------------------
  const submitInput = useCallback(async (text: string, mode: InputMode) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Handle slash commands
    if (mode === "normal" && trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmdName = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
      const cmdArgs = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : "";

      if (cmdName.startsWith("/skill:")) {
        const [skillName] = parseSkillCommand(trimmed);
        if (skillName) {
          chat.enqueueOrExecute(trimmed, mode);
          return;
        }
      }

      if (ALWAYS_IMMEDIATE.has(cmdName)) {
        await dispatch(cmdName, cmdArgs);
        return;
      }

      if (phaseRef.current === "connecting" && BYPASS_WHEN_CONNECTING.has(cmdName)) {
        await dispatch(cmdName, cmdArgs);
        return;
      }

      if (IMMEDIATE_UI.has(cmdName)) {
        await dispatch(cmdName, cmdArgs);
        return;
      }

      if (SIDE_EFFECT_FREE.has(cmdName)) {
        await dispatch(cmdName, cmdArgs);
        return;
      }

      if (phaseRef.current === "startup_error" && STARTUP_RECOVERY_COMMANDS.has(cmdName)) {
        await dispatch(cmdName, cmdArgs);
        return;
      }

      chat.enqueueOrExecute(trimmed, mode);
      return;
    }

    // Normal message
    chat.enqueueOrExecute(trimmed, mode);
  }, [phaseRef, dispatch, chat.enqueueOrExecute]);

  // ---------------------------------------------------------------------------
  // Initial connection (runs once on mount)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (props.initialError) return;

    connection.initializeConnection(async (client) => {
      // Post-connection setup: load commands, restore history, submit prompt
      commands.loadCommands(client);
      if (!props.initialPrompt) {
        await chat.loadMostRecentThread();
      }
      if (props.initialPrompt) {
        submitInput(props.initialPrompt, "normal");
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Keyboard input (global handlers)
  // ---------------------------------------------------------------------------
  useInput((_input, key) => {
    if (key.escape && modals.activeModal) {
      modals.closeModal();
      return;
    }

    if (key.ctrl && _input === "c") {
      exit();
      return;
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (phase === "connecting") {
    return <ConnectingScreen serverUrl={props.serverUrl} />;
  }

  if (phase === "startup_error") {
    return (
      <ErrorScreen
        serverError={connection.serverError}
        serverUrl={props.serverUrl}
        inputMode={chat.inputMode}
        onModeChange={chat.setInputMode}
        onSubmit={submitInput}
      />
    );
  }

  return (
    <MainScreen
      phase={phase}
      effectiveModel={effectiveModel}
      serverUrl={props.serverUrl}
      messages={chat.messages}
      showTimestamps={showTimestamps}
      currentThreadId={chat.currentThreadId}
      inputMode={chat.inputMode}
      spinnerStatus={chat.spinnerStatus}
      agentCwd={chat.agentCwd}
      onModeChange={chat.setInputMode}
      onSubmit={submitInput}
      onThreadSelect={chat.loadThreadHistory}
      activeModal={modals.activeModal}
      onCloseModal={modals.closeModal}
      clientRef={clientRef}
      modalModels={modals.modalModels}
      modalAgents={modals.modalAgents}
      modalMcpServers={modals.modalMcpServers}
      modalLoading={modals.modalLoading}
      loadModalModels={modals.loadModalModels}
      loadModalAgents={modals.loadModalAgents}
      loadModalMcp={modals.loadModalMcp}
      onModalModelSelect={(spec) => {
        setEffectiveModel(spec);
        modals.closeModal();
        chat.addAppMessage(`Model switched to ${spec}`);
      }}
      onModalAgentSelect={(_name) => {
        modals.closeModal();
        chat.addAppMessage("Agent switching requires a server restart to take effect.");
      }}
      onModalThemeSelect={(theme) => {
        modals.closeModal();
        chat.addAppMessage(`Theme: ${theme} (persistence is not yet implemented).`);
      }}
      onModalAuthDismiss={modals.closeModal}
      pendingApproval={chat.pendingApproval}
      onApprovalDecide={chat.handleApprovalDecision}
      autoApprove={props.autoApprove}
      skills={commands.skills}
      mergedCommands={commands.mergedCommands}
      sessionStats={sessionStats}
      columns={columns}
      agentName={props.agentName}
    />
  );
};
