// =============================================================================
// Main Ink app component — equivalent to Python tui.app.DeepAgentsApp
//
// This is the top-level React component rendered by Ink. It manages:
//   - Server connection state
//   - Chat message queue
//   - Slash command dispatch
//   - HITL approval / ask_user modal state
//   - Thread/session state
// =============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { DOMElement } from "ink";
import { Box, Text, useInput, useApp, useBoxMetrics, useWindowSize } from "ink";
import {
  ALWAYS_IMMEDIATE, BYPASS_WHEN_CONNECTING, IMMEDIATE_UI, SIDE_EFFECT_FREE,
  STARTUP_RECOVERY_COMMANDS, parseSkillCommand,
} from "./command-registry.js";
import type {
  ChatMessageData, SessionStats, SpinnerStatus, AppPhase, InputMode, ToolCallData,
} from "./types.js";
import { TuiClient } from "./client.js";
import { executeAgentTask, resumeAgentTask } from "./tui-adapter.js";
import type { TuiAdapterCallbacks, ExecutionContext } from "./tui-adapter.js";
import { MessageList } from "./components/messages.js";
import { Loading } from "./components/loading.js";
import { ChatInput } from "./components/chat-input.js";
import { WelcomeScreen } from "./components/welcome.js";
import { ApprovalMenu } from "./components/approval.js";
import type { ApprovalRequest, ApprovalResult } from "./components/approval.js";
import { ThreadSelector } from "./components/thread-selector.js";
import { formatTokenCount } from "./formatting.js";
import { getLogger, getLogFilePath, isDebugEnabled } from "./logging.js";

const logger = getLogger("tui.app");

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
// Internal types
// =============================================================================

interface QueuedMessage {
  text: string;
  mode: InputMode;
  id: string;
}

// =============================================================================
// App component
// =============================================================================

export const App: React.FC<AppProps> = (props) => {
  const { exit } = useApp();

  // Terminal dimensions — useWindowSize re-renders on resize automatically.
  const { rows, columns } = useWindowSize();

  // Scroll command channel. Instead of a single ±1 tick (which forced every
  // input device through one fixed half-page step, making the mouse wheel feel
  // like violent jumps), each scroll input emits a signed ROW delta sized to
  // that device:
  //   mouse wheel  → ±2 rows   (native-wheel feel)
  //   arrow keys   → ±1 row
  //   PageUp/Down  → ±(half viewport) rows
  // MessageList consumes `scrollCommand` via an effect keyed on its id, so
  // every event fires exactly once regardless of sign/magnitude.
  const [scrollCommand, setScrollCommand] = useState<{ id: number; deltaRows: number }>({
    id: 0,
    deltaRows: 0,
  });
  const scrollCmdSeq = useRef(0);
  const emitScroll = useCallback((deltaRows: number) => {
    scrollCmdSeq.current += 1;
    setScrollCommand({ id: scrollCmdSeq.current, deltaRows });
  }, []);

  // ---------------------------------------------------------------------------
  // Yoga-driven message viewport sizing
  // ---------------------------------------------------------------------------
  // Instead of the old `rows - 6` magic constant, we let yoga compute the real
  // available height for the message list by measuring the MessageListRegion
  // Box after layout. useBoxMetrics auto-updates on resize, on chrome (Loading/
  // Approval) appearing/disappearing, and on InputRegion height changes (e.g.
  // the completion popup expanding) — so the viewport stays in sync with the
  // actual rendered chrome with zero hand-tuned constants.
  const messageRegionRef = useRef<DOMElement>(null);
  const messageRegionMetrics = useBoxMetrics(messageRegionRef);
  // Measured message-region height, used as the virtual-scroll viewport size.
  //
  // CRITICAL: we must never feed a tiny positive height (1–3 rows) to
  // MessageList. A measured height that small means yoga hasn't stabilised
  // (e.g. the region is momentarily squeezed by chrome/input, or the welcome
  // screen just unmounted). In that state computeVisibleRange would slice down
  // to an EMPTY range and the message area goes BLANK — the exact bug we hit.
  // So: treat any measured height below MIN_VIEWPORT as "not ready" and fall
  // back to a sane estimate; once yoga reports a usable height we trust it.
  const MIN_VIEWPORT_ROWS = 4;
  const fallbackViewport = Math.max(MIN_VIEWPORT_ROWS, rows - 8);
  const measuredHeight = messageRegionMetrics.height;
  const messageViewportHeight =
    messageRegionMetrics.hasMeasured && measuredHeight >= MIN_VIEWPORT_ROWS
      ? measuredHeight
      : fallbackViewport;

  // ---------------------------------------------------------------------------
  // Server connection state
  // ---------------------------------------------------------------------------
  // If the launcher already determined the server is unreachable (e.g. the
  // auto-start failed), boot straight into the error screen instead of
  // looping on "Connecting...".
  const [phase, setPhase] = useState<AppPhase>(
    props.initialError ? "startup_error" : "connecting",
  );
  const [serverError, setServerError] = useState<string | null>(props.initialError ?? null);
  const clientRef = useRef<TuiClient | null>(null);

  // ---------------------------------------------------------------------------
  // Chat state
  // ---------------------------------------------------------------------------
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("normal");
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [spinnerStatus, setSpinnerStatus] = useState<SpinnerStatus>(null);

  // ---------------------------------------------------------------------------
  // Model / agent state
  // ---------------------------------------------------------------------------
  const [effectiveModel, setEffectiveModel] = useState<string | null>(props.modelSpec ?? null);
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    requestCount: 0, inputTokens: 0, outputTokens: 0, wallTimeSeconds: 0, perModel: {},
  });
  const [showTimestamps, setShowTimestamps] = useState(false);

  // ---------------------------------------------------------------------------
  // Modal state
  // ---------------------------------------------------------------------------
  const [activeModal, setActiveModal] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // HITL approval state — set when the agent pauses for tool-call approval.
  // The ApprovalMenu renders while this is non-null; on decision we call
  // resumeAgentTask to send the approve/reject back to the server.
  // ---------------------------------------------------------------------------
  const [pendingApproval, setPendingApproval] = useState<{
    requests: ApprovalRequest[];
  } | null>(null);
  const execContextRef = useRef<ExecutionContext | null>(null);
  const pendingApprovalRef = useRef<typeof pendingApproval>(null);
  pendingApprovalRef.current = pendingApproval;
  const drainQueueRef = useRef<() => void>(() => {});

  // ---------------------------------------------------------------------------
  // Refs for mutable state (avoids stale closures in async handlers)
  // ---------------------------------------------------------------------------
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const queueRef = useRef(messageQueue);
  queueRef.current = messageQueue;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const threadRef = useRef(currentThreadId);
  threadRef.current = currentThreadId;

  // ---------------------------------------------------------------------------
  // TUI adapter callbacks — bridge between streaming adapter and React state
  // ---------------------------------------------------------------------------
  const adapterCallbacks = useRef<TuiAdapterCallbacks>({
    addMessage: (msg) => {
      setMessages((prev) => [...prev, msg]);
    },
    updateMessage: (id, updates) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    updateToolCall: (tool) => {
      // Tool calls are stored inline in assistant messages for now
      // Will be expanded in Phase 4 with proper tool widgets
    },
    setSpinner: (status) => {
      setSpinnerStatus(status);
    },
    updateStats: (stats) => {
      setSessionStats((prev) => ({
        ...prev,
        ...stats,
        perModel: { ...prev.perModel },
      }));
    },
    requestApproval: async (_toolName, _args) => {
      // Legacy callback — approval now flows through onApprovalRequired which
      // carries the full actionRequests list from the server. Kept for
      // interface compatibility; not expected to be called.
      return "approve";
    },
    requestAskUser: async (_questions) => {
      // ask_user widget resume endpoint is not yet implemented on the server.
      // For now, cancel so the agent receives feedback.
      return { type: "cancelled" };
    },
    onApprovalRequired: (_questions, actionRequests) => {
      // Build ApprovalRequest list from the server's actionRequests payload.
      // Each entry carries the tool name + args for rendering in ApprovalMenu.
      const requests: ApprovalRequest[] = actionRequests.length > 0
        ? (actionRequests as Array<Record<string, unknown>>).map((ar) => ({
            toolName: (ar.name as string) ?? "unknown",
            args: (ar.args as Record<string, unknown>) ?? {},
            isBatch: actionRequests.length > 1,
            batchSize: actionRequests.length,
          }))
        : [{ toolName: "未知操作", args: {} }];
      setPendingApproval({ requests });
      setPhase("blocked");
    },
    onInterrupted: (message) => {
      // The HITL approval UI is handled by onApprovalRequired (ApprovalMenu).
      // This callback is only a fallback for generic "interrupted" events that
      // don't carry actionRequests. We do NOT add a message to the chat
      // history here — that would leave stale "[HITL]" entries after the user
      // approves, which pollutes the conversation.
      logger.debug(`Stream interrupted: ${message}`);
      setPhase("blocked");
    },
    onError: (message) => {
      logger.error(`UI error displayed: ${message}`);
      setPhase("ready");
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: "error",
          content: message,
          timestamp: Date.now(),
        },
      ]);
    },
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const addAppMessage = useCallback((text: string) => {
    const msg: ChatMessageData = {
      id: `app_${Date.now()}`,
      role: "app",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  // ---------------------------------------------------------------------------
  // Thread history loading
  // ---------------------------------------------------------------------------
  // Maps a server MessageRow (snake_case, ISO createdAt) into the camelCase
  // ChatMessageData the MessageList consumes. Tool/extra metadata is preserved
  // on `metadata` so existing render code keeps working. Roles outside the
  // local union (e.g. legacy "tool") are normalised to "assistant" to avoid
  // gaps in the rendered transcript.
  const rowToMessage = (row: {
    id: string;
    role: string;
    content: string;
    toolCalls?: unknown;
    extraMetadata?: Record<string, unknown>;
    createdAt: string;
  }): ChatMessageData => {
    const role = (["user", "assistant", "tool", "error", "app", "skill",
      "summarization", "diff", "subagent"] as const).includes(
        row.role as ChatMessageData["role"],
      )
      ? (row.role as ChatMessageData["role"])
      : "assistant";
    const metadata: Record<string, unknown> = {};
    if (row.extraMetadata) Object.assign(metadata, row.extraMetadata);
    if (row.toolCalls) metadata["toolCalls"] = row.toolCalls;
    return {
      id: row.id,
      role,
      content: row.content ?? "",
      timestamp: Date.parse(row.createdAt) || Date.now(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  };

  /**
   * Fetch a thread's full message history from the server and load it into the
   * local `messages` state, replacing whatever is currently shown. Also sets
   * `currentThreadId` so subsequent chat turns append to this thread.
   *
   * This is what makes the scrollback show the ENTIRE conversation instead of
   * only messages from the current TUI session — the server is the source of
   * truth, the TUI is just a view over it.
   */
  const loadThreadHistory = useCallback(async (threadId: string): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const { history } = await client.getThreadHistory(threadId);
      setCurrentThreadId(threadId);
      setMessages(history.map(rowToMessage));
    } catch (err) {
      logger.exception(`Failed to load history for thread ${threadId}`, err);
    }
  }, []);

  /**
   * Load the most recent thread (if any) so the TUI opens straight into the
   * user's latest conversation with full scrollback. If there are no threads,
   * we stay on a fresh empty state — the first message will create a thread.
   */
  const loadMostRecentThread = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const threads = await client.listThreads();
      // listThreads returns newest-first (orderBy desc createdAt) on the server.
      if (threads.length > 0 && threads[0]) {
        await loadThreadHistory(threads[0].id);
      }
    } catch (err) {
      logger.exception("Failed to load recent thread list", err);
    }
  }, [loadThreadHistory]);

  // ---------------------------------------------------------------------------
  // /log command — show the log file path and tail the last entries
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

    // Try to read the last 15 lines
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

    addAppMessage(lines.join("\n"));
  }, [addAppMessage]);

  // ---------------------------------------------------------------------------
  // Agent execution — dispatches to tui-adapter
  // ---------------------------------------------------------------------------
  const executeMessage = useCallback(async (text: string, _mode: InputMode) => {
    const client = clientRef.current;
    if (!client) {
      addAppMessage("Error: No server connection.");
      setPhase("ready");
      return;
    }

    // Add user message
    const userMsg: ChatMessageData = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setPhase("running");

    const abortController = new AbortController();
    const execContext: ExecutionContext = {
      client,
      callbacks: adapterCallbacks.current,
      threadId: threadRef.current ?? undefined,
      agentName: props.agentName,
      autoApprove: props.autoApprove,
      abortSignal: abortController.signal,
    };
    // Stash the context so handleApprovalDecision can reuse it to resume.
    execContextRef.current = execContext;

    try {
      await executeAgentTask(execContext, text);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        logger.exception("executeMessage failed", err);
        adapterCallbacks.current.onError((err as Error).message);
      }
    }

    // Only return to "ready" if we're not waiting on a HITL approval.
    // onApprovalRequired (fired during the stream) sets phase to "blocked" and
    // a pending approval; in that case we must NOT override it.
    setPendingApproval((current) => {
      if (current) {
        setPhase("blocked");
      } else {
        setPhase("ready");
        setSpinnerStatus(null);
      }
      return current;
    });

    // Drain queue if any (skipped when blocked)
    if (!pendingApprovalRef.current) {
      drainQueueRef.current();
    }
  }, [props.agentName, props.autoApprove, addAppMessage]);

  // ---------------------------------------------------------------------------
  // Drain message queue
  // ---------------------------------------------------------------------------
  const drainQueue = useCallback(() => {
    const queued = queueRef.current;
    if (queued.length > 0) {
      const next = queued[0];
      setMessageQueue((prev) => prev.slice(1));
      executeMessage(next.text, next.mode);
    }
  }, [executeMessage]);
  drainQueueRef.current = drainQueue;

  // ---------------------------------------------------------------------------
  // HITL approval decision — called by ApprovalMenu when the user picks
  // approve / reject. Sends the decision to the server via resumeAgentTask.
  // ---------------------------------------------------------------------------
  const handleApprovalDecision = useCallback(async (result: ApprovalResult) => {
    // Record the decision in the chat history before clearing the menu.
    const toolNames = pendingApprovalRef.current?.requests
      .map((r) => r.toolName)
      .join(", ") ?? "unknown";
    if (result.decision === "approve") {
      addAppMessage(`✓ 已批准: ${toolNames}`);
    } else if (result.decision === "auto_approve") {
      addAppMessage(`✓ 已批准 (自动): ${toolNames}`);
    } else {
      addAppMessage(`✗ 已拒绝: ${toolNames}${result.reason ? ` — ${result.reason}` : ""}`);
    }

    setPendingApproval(null);
    const ctx = execContextRef.current;
    if (!ctx || !ctx.threadId) {
      addAppMessage("无法恢复执行：没有活动会话。");
      setPhase("ready");
      return;
    }
    const approved = result.decision === "approve" || result.decision === "auto_approve";
    setPhase("running");
    try {
      await resumeAgentTask(ctx, approved);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        logger.exception("handleApprovalDecision resume failed", err);
        adapterCallbacks.current.onError((err as Error).message);
      }
    }
    // After resume, check if there's a nested interrupt (multi-step approval)
    if (!pendingApprovalRef.current) {
      setPhase("ready");
      setSpinnerStatus(null);
      drainQueueRef.current();
    }
  }, [addAppMessage]);

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------
  const enqueueOrExecute = useCallback((text: string, mode: InputMode) => {
    if (phaseRef.current === "running") {
      const queued: QueuedMessage = { text, mode, id: `q_${Date.now()}` };
      setMessageQueue((prev) => [...prev, queued]);
      const msg: ChatMessageData = {
        id: queued.id,
        role: "user",
        content: `${text} [queued]`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, msg]);
    } else {
      executeMessage(text, mode);
    }
  }, [phaseRef, executeMessage]);

  // ---------------------------------------------------------------------------
  // Slash command dispatch
  // ---------------------------------------------------------------------------
  const dispatchCommand = useCallback(async (cmdName: string, cmdArgs: string): Promise<void> => {
    switch (cmdName) {
      case "/quit":
      case "/q":
        exit();
        break;

      case "/version":
      case "/about":
        addAppMessage("Octopus TUI v0.1.0");
        break;

      case "/help":
        addAppMessage(
          "Available commands: /help, /quit, /clear, /model, /agents, /threads, /theme, " +
          "/auth, /mcp, /tokens, /offload, /editor, /copy, /timestamps, /update, /install, " +
          "/changelog, /version, /feedback, /docs, /notifications, /remember, /skill-creator, " +
          "/reload, /force-clear"
        );
        break;

      case "/clear":
        setMessages([]);
        setCurrentThreadId(null);
        addAppMessage("Chat cleared. New thread will be created on next message.");
        break;

      case "/force-clear":
        setMessages([]);
        setCurrentThreadId(null);
        setMessageQueue([]);
        setSpinnerStatus(null);
        setPhase("ready");
        addAppMessage("Chat force-cleared.");
        break;

      case "/model":
        setActiveModal("model");
        break;

      case "/agents":
        setActiveModal("agents");
        break;

      case "/threads":
        setActiveModal("threads");
        break;

      case "/theme":
        setActiveModal("theme");
        break;

      case "/auth":
      case "/connect":
        setActiveModal("auth");
        break;

      case "/mcp":
        setActiveModal("mcp");
        break;

      case "/notifications":
        setActiveModal("notifications");
        break;

      case "/timestamps":
        setShowTimestamps((prev) => !prev);
        addAppMessage(`Timestamps ${showTimestamps ? "hidden" : "shown"}.`);
        break;

      case "/tokens":
        addAppMessage(
          `Session: ${sessionStats.requestCount} requests, ` +
          `${formatTokenCount(sessionStats.inputTokens)} in / ${formatTokenCount(sessionStats.outputTokens)} out`
        );
        break;

      case "/copy": {
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant) {
          addAppMessage(`Copied to clipboard (${lastAssistant.content.length} chars)`);
        } else {
          addAppMessage("No assistant message to copy.");
        }
        break;
      }

      case "/log": {
        showLogTail();
        break;
      }

      case "/trace":
      case "/changelog":
      case "/feedback":
      case "/docs":
        addAppMessage(`${cmdName}: opening in browser... (Phase 6)`);
        break;

      case "/editor":
        addAppMessage("Opening external editor... (Phase 6)");
        break;

      case "/offload":
      case "/compact":
        addAppMessage("Offloading context... (Phase 5)");
        break;

      case "/remember":
        addAppMessage("Updating memory... (Phase 5)");
        break;

      case "/skill-creator":
        addAppMessage("Skill creator guide... (Phase 5)");
        break;

      case "/update":
        addAppMessage("Checking for updates... (Phase 6)");
        break;

      case "/install":
        addAppMessage(`Installing ${cmdArgs || "package"}... (Phase 6)`);
        break;

      case "/auto-update":
        addAppMessage("Auto-update toggled. (Phase 6)");
        break;

      case "/reload":
        setPhase("connecting");
        setServerError(null);
        addAppMessage("Reloading configuration...");
        // Retry connection
        initializeConnection();
        break;

      case "/debug-error":
        addAppMessage("Debug mode — this is a hidden command.");
        break;

      case "/restart":
        addAppMessage("Restarting server connection...");
        setPhase("connecting");
        setServerError(null);
        initializeConnection();
        break;

      default:
        addAppMessage(`Unknown command: ${cmdName}. Type /help for available commands.`);
    }
  }, [messages, sessionStats, showTimestamps, exit, addAppMessage]);

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
          enqueueOrExecute(trimmed, mode);
          return;
        }
      }

      if (ALWAYS_IMMEDIATE.has(cmdName)) {
        await dispatchCommand(cmdName, cmdArgs);
        return;
      }

      if (phaseRef.current === "connecting" && BYPASS_WHEN_CONNECTING.has(cmdName)) {
        await dispatchCommand(cmdName, cmdArgs);
        return;
      }

      if (IMMEDIATE_UI.has(cmdName)) {
        await dispatchCommand(cmdName, cmdArgs);
        return;
      }

      if (SIDE_EFFECT_FREE.has(cmdName)) {
        await dispatchCommand(cmdName, cmdArgs);
        return;
      }

      if (phaseRef.current === "startup_error" && STARTUP_RECOVERY_COMMANDS.has(cmdName)) {
        await dispatchCommand(cmdName, cmdArgs);
        return;
      }

      enqueueOrExecute(trimmed, mode);
      return;
    }

    // Normal message
    enqueueOrExecute(trimmed, mode);
  }, [phaseRef, enqueueOrExecute, dispatchCommand]);

  // ---------------------------------------------------------------------------
  // Server connection initialization
  // ---------------------------------------------------------------------------
  const initializeConnection = useCallback(async () => {
    setPhase("connecting");
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
            addAppMessage(
              `Warning: No API key found for "${provider}". ` +
              `Use /auth to configure one, or check ~/.deepagents/config.json.`
            );
          }
        }
      } catch (err) {
        logger.warn("Model credential verification skipped", err);
      }
    }

    try {
      const client = new TuiClient({ baseUrl: props.serverUrl, token: props.token });
      clientRef.current = client;

      // The TUI starts as an anonymous user: the server's chat routes use
      // `getOptionalUser`, which falls back to a `dev-user` when no token is
      // supplied, so we never need to log in or check first-run state to
      // begin chatting. We only verify the server is reachable.
      const health = await client.checkHealth();
      if (!health.ok) {
        setServerError(health.error ?? `Cannot connect to server at ${props.serverUrl}`);
        setPhase("startup_error");
        return;
      }

      setPhase("ready");

      // Restore the most recent conversation so the user opens into full
      // scrollback of their last session. Skipped when an --initial-prompt is
      // supplied, because that signals an explicit new one-shot interaction
      // which we send below (and which will create its own thread).
      if (!props.initialPrompt) {
        await loadMostRecentThread();
      }

      if (props.initialPrompt) {
        submitInput(props.initialPrompt, "normal");
      }
    } catch (err) {
      logger.exception("Server connection failed", err);
      setServerError(`Cannot connect to server at ${props.serverUrl}: ${(err as Error).message}`);
      setPhase("startup_error");
    }
  }, [props.serverUrl, props.token]);

  useEffect(() => {
    // Skip the auto-connect when the launcher already established a failure
    // (e.g. auto-start failed) — let the error screen stand until the user
    // explicitly retries via /reload or /restart.
    if (props.initialError) return;
    initializeConnection();
  }, [initializeConnection, props.initialError]);

  // ---------------------------------------------------------------------------
  // Keyboard input (global handlers)
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape && activeModal) {
      setActiveModal(null);
      return;
    }

    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    // SGR mouse reporting: ESC[<Cb;Cx;CyM (press) / ESC[<Cb;Cx;Cym (release)
    // Cb=64 → scroll up, Cb=65 → scroll down. Capture these to scroll the
    // message area, otherwise they'd be filtered out by ChatInput without
    // any effect. Small per-tick delta so the wheel feels like a native
    // terminal/editor, not a half-page jump.
    const WHEEL_STEP_ROWS = 2;
    if (input.startsWith("\x1b[<")) {
      const match = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
      if (match) {
        const cb = parseInt(match[1]!, 10);
        // Scroll up
        if (cb === 64) { emitScroll(+WHEEL_STEP_ROWS); return; }
        // Scroll down
        if (cb === 65) { emitScroll(-WHEEL_STEP_ROWS); return; }
        // Other mouse events (click, drag) — consume without action.
        return;
      }
    }

    // Virtual scroll: PageUp / Ctrl+U — scroll up half a page.
    if (key.pageUp || input === "\x1b[5~" || (key.ctrl && input === "u")) {
      emitScroll(+Math.max(1, Math.floor(messageViewportHeight / 2)));
      return;
    }

    // Virtual scroll: PageDown / Ctrl+D — scroll down half a page.
    if (key.pageDown || input === "\x1b[6~" || (key.ctrl && input === "d")) {
      emitScroll(-Math.max(1, Math.floor(messageViewportHeight / 2)));
      return;
    }

    // Fallback: when SGR mouse reporting isn't supported by the terminal,
    // the mouse wheel generates Up/Down arrow events instead.  Route those
    // to message scrolling (single row each) so the user doesn't lose scroll
    // ability. ChatInput will also handle these for history navigation — both
    // handlers fire independently in Ink; this is acceptable behaviour.
    if (key.upArrow) { emitScroll(+1); return; }
    if (key.downArrow) { emitScroll(-1); return; }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (phase === "connecting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row">
          <Text color="yellow" bold>⏳ Octopus TUI</Text>
        </Box>
        <Box marginY={1}>
          <Text dimColor>Connecting to </Text>
          <Text color="cyan">{props.serverUrl}</Text>
          <Text dimColor>...</Text>
        </Box>
        <Loading status="Thinking" detail="Checking server health..." />
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Press Ctrl+C to exit.</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Make sure the Octopus server is running:
              {'  '}cd server && npm run dev
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (phase === "startup_error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row">
          <Text color="red" bold>✗ Connection failed</Text>
        </Box>
        <Box marginY={1} flexDirection="column">
          <Text color="red">{serverError}</Text>
          <Box marginTop={1}>
            <Text dimColor>Server URL: </Text>
            <Text>{props.serverUrl}</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Recovery commands: /install, /reload, /update, /quit</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Or type a command above to retry.</Text>
        </Box>
        <ChatInput
          inputMode={inputMode}
          phase={phase}
          onModeChange={setInputMode}
          onSubmit={(text, mode) => submitInput(text, mode)}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      {/* Body — fills all space between the top and the input area. The
          alternate screen + flexGrow layout means the input area stays pinned
          at the bottom and never scrolls away, regardless of how many messages
          are in the message list. */}
      <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        {/* Message region — flexGrow so it claims all space the ChromeRegion
            below does not need.  Its measured height drives the virtual-scroll
            viewport in MessageList (yoga owns the geometry, no magic constants). */}
        <Box ref={messageRegionRef} flexDirection="column" flexGrow={1} minHeight={0}>
          {/* Welcome screen — shown when idle with no messages */}
          {messages.length === 0 && phase === "ready" && (
            <WelcomeScreen
              model={effectiveModel}
              agentName={props.agentName}
              serverUrl={props.serverUrl}
              columns={columns}
            />
          )}

          {/* Message list — viewport height comes from useBoxMetrics above */}
          <MessageList
            messages={messages}
            showTimestamps={showTimestamps}
            viewportHeight={messageViewportHeight}
            columns={columns}
            scrollCommand={scrollCommand}
          />
        </Box>

        {/* Chrome region — dynamic chrome (loading, approval, modals).
            flexShrink={0} so each piece claims its natural height; the message
            region above absorbs the difference via flexGrow. When chrome
            appears/disappears, useBoxMetrics re-measures and the viewport
            adapts automatically. */}
        <Box flexDirection="column" flexShrink={0}>
          {/* Loading indicator */}
          {phase === "running" && spinnerStatus && (
            <Loading status={spinnerStatus} />
          )}

          {/* HITL approval menu — agent paused awaiting tool-call approval */}
          {pendingApproval && (
            <ApprovalMenu
              requests={pendingApproval.requests}
              onDecide={handleApprovalDecision}
              autoApprove={props.autoApprove}
            />
          )}

          {/* Modal overlay.
              - "threads": real ThreadSelector — choosing a thread loads its
                full history (see loadThreadHistory), so scrollback shows the
                entire conversation, not just the current session.
              - other modals: still placeholders pending Phase 5. */}
          {activeModal === "threads" && (
            <ThreadSelector
              client={clientRef.current}
              currentThreadId={currentThreadId}
              onSelect={async (threadId) => {
                setActiveModal(null);
                await loadThreadHistory(threadId);
              }}
              onDismiss={() => setActiveModal(null)}
            />
          )}
          {activeModal && activeModal !== "threads" && (
            <ModalPlaceholder name={activeModal} onDismiss={() => setActiveModal(null)} />
          )}
        </Box>
      </Box>

      {/* Input area — flexShrink: 0 keeps it from being compressed; the
          completion popup grows this region and the message region shrinks
          accordingly via yoga. */}
      <Box flexShrink={0} flexDirection="column">
        <ChatInput
          inputMode={inputMode}
          phase={phase}
          onModeChange={setInputMode}
          onSubmit={(text, mode) => submitInput(text, mode)}
          statusBar={{
            model: effectiveModel,
            threadId: currentThreadId,
            phase,
            spinner: spinnerStatus,
            stats: sessionStats,
            agentName: props.agentName,
          }}
        />
      </Box>
    </Box>
  );
};

// =============================================================================
// Modal placeholder (replaced by real modals in Phase 5)
// =============================================================================

const ModalPlaceholder: React.FC<{
  name: string;
  onDismiss: () => void;
}> = ({ name }) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold>{name} selector</Text>
      <Text dimColor>Coming in Phase 5. Press Esc to dismiss.</Text>
    </Box>
  );
};
