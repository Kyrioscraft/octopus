// =============================================================================
// Command dispatch — routes slash commands to their handlers.
//
// Extracted from the dispatchCommand function in app.tsx. Replaces the
// original dual-switch routing with a centralized handler map. Each system
// action maps to a handler function; TUI-only fallback commands are handled
// by the name-based switch (for commands with no core systemAction).
// =============================================================================

import type { InputMode, AppPhase, ChatMessageData, SessionStats, SpinnerStatus } from "../types.js";
import type { MergedCommand } from "../command-registry.js";
import { formatTokenCount } from "../formatting.js";

// =============================================================================
// Types
// =============================================================================

export interface DispatchDeps {
  /** exit() from useApp(). */
  exit: () => void;
  /** Add an app-role message. */
  addAppMessage: (text: string) => void;
  /** Execute a message against the agent. */
  executeMessage: (text: string, mode: InputMode) => void;
  /** Open/close a modal by name (null to close). */
  setActiveModal: (name: string | null) => void;
  /** Chat messages (for /copy-last). */
  messages: ChatMessageData[];
  /** Replace all messages (for /clear, /force-clear). */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
  /** Reset thread ID (for /clear, /force-clear). */
  setCurrentThreadId: (id: string | null) => void;
  /** Reset agent cwd (for /clear, /force-clear). */
  setAgentCwd: (cwd: string | null) => void;
  /** Reset message queue (for /force-clear). */
  setMessageQueue: React.Dispatch<React.SetStateAction<{
    text: string; mode: InputMode; id: string;
  }[]>>;
  /** Reset spinner (for /force-clear). */
  setSpinnerStatus: (status: SpinnerStatus) => void;
  /** Set app phase (for /force-clear, /reload, /restart). */
  setPhase: (phase: AppPhase) => void;
  /** Reset server error (for /reload, /restart). */
  setServerError: (err: string | null) => void;
  /** Toggle timestamp display. */
  showTimestamps: boolean;
  setShowTimestamps: React.Dispatch<React.SetStateAction<boolean>>;
  /** Session statistics (for /tokens). */
  sessionStats: SessionStats;
  /** Name → MergedCommand lookup. */
  commandIndex: Map<string, MergedCommand>;
  /** Reconnect to server (for /reload, /restart). */
  reconnect: () => void;
  /** Show log tail (for /log). */
  showLogTail: () => void;
}

export type DispatchCommand = (cmdName: string, cmdArgs: string) => Promise<void>;

// =============================================================================
// Factory
// =============================================================================

export function createDispatchCommand(deps: DispatchDeps): DispatchCommand {
  const {
    exit, addAppMessage, executeMessage, setActiveModal,
    messages, setMessages, setCurrentThreadId, setAgentCwd,
    setMessageQueue, setSpinnerStatus, setPhase, setServerError,
    showTimestamps, setShowTimestamps, sessionStats,
    commandIndex, reconnect, showLogTail,
  } = deps;

  return async (cmdName: string, cmdArgs: string): Promise<void> => {
    // Resolve the command's systemAction from the merged command index.
    const merged = commandIndex.get(cmdName);
    const systemAction = merged?.systemAction;

    // --- System-action-based routing (server-authoritative commands) ---
    switch (systemAction) {
      case "quit":
        exit();
        return;

      case "version":
        addAppMessage("Octopus TUI v0.1.0");
        return;

      case "help":
        addAppMessage(
          "Available commands: /help, /quit, /clear, /model, /agents, /threads, /theme, " +
          "/auth, /mcp, /tokens, /offload, /editor, /copy, /timestamps, /update, /install, " +
          "/changelog, /version, /feedback, /docs, /notifications, /remember, /skill-creator, " +
          "/reload, /force-clear"
        );
        return;

      case "clear":
        setMessages([]);
        setCurrentThreadId(null);
        setAgentCwd(null);
        addAppMessage("Chat cleared. New thread will be created on next message.");
        return;

      case "model":
        setActiveModal("model");
        return;

      case "agents":
        setActiveModal("agents");
        return;

      case "threads":
        setActiveModal("threads");
        return;

      case "theme":
        setActiveModal("theme");
        return;

      case "notifications":
        setActiveModal("notifications");
        return;

      case "tokens":
        addAppMessage(
          `Session: ${sessionStats.requestCount} requests, ` +
          `${formatTokenCount(sessionStats.inputTokens)} in / ${formatTokenCount(sessionStats.outputTokens)} out`
        );
        return;

      case "copy-last": {
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant) {
          addAppMessage(`Copied to clipboard (${lastAssistant.content.length} chars)`);
        } else {
          addAppMessage("No assistant message to copy.");
        }
        return;
      }

      // Commands with no TUI backend yet
      case "changelog":
      case "feedback":
      case "docs":
      case "trace":
      case "update":
      case "install":
      case "auto-update":
      case "offload":
      case "editor":
      case "remember":
      case "skill-creator":
        addAppMessage(`${cmdName}: 该功能暂未在 TUI 实现。`);
        return;
    }

    // --- Name-based fallback for TUI-only commands (no core systemAction) ---
    switch (cmdName) {
      case "/force-clear":
        setMessages([]);
        setCurrentThreadId(null);
        setAgentCwd(null);
        setMessageQueue([]);
        setSpinnerStatus(null);
        setPhase("ready");
        addAppMessage("Chat force-cleared.");
        return;

      case "/auth":
      case "/connect":
        setActiveModal("auth");
        return;

      case "/mcp":
        setActiveModal("mcp");
        return;

      case "/timestamps":
        setShowTimestamps((prev) => !prev);
        addAppMessage(`Timestamps ${showTimestamps ? "hidden" : "shown"}.`);
        return;

      case "/log":
        showLogTail();
        return;

      case "/reload":
        setPhase("connecting");
        setServerError(null);
        addAppMessage("Reloading configuration...");
        reconnect();
        return;

      case "/debug-error":
        addAppMessage("Debug mode — this is a hidden command.");
        return;

      case "/restart":
        addAppMessage("Restarting server connection...");
        setPhase("connecting");
        setServerError(null);
        reconnect();
        return;

      default:
        // If the command is a prompt-type command (user-defined template),
        // dispatch it as a normal chat message so the agent processes it.
        if (merged?.kind === "prompt" && merged.promptTemplate) {
          const expanded = merged.promptTemplate.replace(/\{input\}/g, cmdArgs);
          if (merged.promptAction === "send") {
            executeMessage(expanded, "normal");
          } else {
            addAppMessage(`Prompt template inserted: ${expanded.slice(0, 80)}${expanded.length > 80 ? "…" : ""}`);
          }
          return;
        }
        addAppMessage(`Unknown command: ${cmdName}. Type /help for available commands.`);
    }
  };
}
