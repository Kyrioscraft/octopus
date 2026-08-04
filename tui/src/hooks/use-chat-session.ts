// =============================================================================
// useChatSession — chat message lifecycle, thread management, and agent
// execution orchestration.
//
// Extracted from app.tsx. Manages:
//   - Chat message list (messages) and thread binding
//   - Message queue (for messages typed while agent is running)
//   - Agent execution via executeAgentTask / resumeAgentTask
//   - TUI adapter callbacks bridging the stream to React state
//   - HITL approval flow
//
// The shared refs (clientRef, workspaceIdRef, phaseRef) are created by the
// caller (app.tsx) and passed in to avoid circular dependencies with
// useServerConnection.
// =============================================================================

import { useState, useRef, useCallback } from "react";
import { cwd as processCwd } from "node:process";
import type {
  ChatMessageData, SpinnerStatus, AppPhase, InputMode,
} from "../types.js";
import { TuiClient } from "../client.js";
import type { ResumeRequestBody } from "../client.js";
import { executeAgentTask, resumeAgentTask } from "../tui-adapter.js";
import type { TuiAdapterCallbacks, ExecutionContext } from "../tui-adapter.js";
import type { ApprovalRequest, ApprovalResult } from "../components/approval.js";
import { getLogger } from "../logging.js";

const logger = getLogger("tui.hooks.chat");

// =============================================================================
// Types
// =============================================================================

export interface QueuedMessage {
  text: string;
  mode: InputMode;
  id: string;
}

export interface UseChatSessionDeps {
  /** Shared ref — TuiClient instance (set by useServerConnection). */
  clientRef: React.MutableRefObject<TuiClient | null>;
  /** Shared ref — workspace ID (set by useServerConnection). */
  workspaceIdRef: React.MutableRefObject<string | null>;
  /** Shared ref — current app phase. */
  phaseRef: React.MutableRefObject<AppPhase>;
  /** Phase setter (synced with phaseRef by useServerConnection). */
  setPhase: (phase: AppPhase) => void;
  agentName: string;
  autoApprove: boolean;
}

export interface UseChatSessionReturn {
  messages: ChatMessageData[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>;
  currentThreadId: string | null;
  setCurrentThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  inputMode: InputMode;
  setInputMode: React.Dispatch<React.SetStateAction<InputMode>>;
  messageQueue: QueuedMessage[];
  setMessageQueue: React.Dispatch<React.SetStateAction<QueuedMessage[]>>;
  spinnerStatus: SpinnerStatus;
  setSpinnerStatus: React.Dispatch<React.SetStateAction<SpinnerStatus>>;
  agentCwd: string | null;
  setAgentCwd: React.Dispatch<React.SetStateAction<string | null>>;
  /** TUI adapter callbacks — bridge from stream events to React state. */
  adapterCallbacks: React.MutableRefObject<TuiAdapterCallbacks>;
  /** Execution context for HITL resume. */
  execContextRef: React.MutableRefObject<ExecutionContext | null>;
  /** HITL approval state — non-null triggers ApprovalMenu. */
  pendingApproval: { requests: ApprovalRequest[] } | null;
  /** Add an app-role message to the chat. */
  addAppMessage: (text: string) => void;
  /** Fetch and load a thread's full message history. */
  loadThreadHistory: (threadId: string) => Promise<void>;
  /** Load the most recent thread scoped to the current workspace. */
  loadMostRecentThread: () => Promise<void>;
  /** Execute a user message against the agent. */
  executeMessage: (text: string, mode: InputMode) => Promise<void>;
  /** Drain one message from the queue (called after agent finishes). */
  drainQueue: () => void;
  /** Enqueue a message if the agent is running, or execute immediately. */
  enqueueOrExecute: (text: string, mode: InputMode) => void;
  /** Handle a HITL approval decision (approve/reject). */
  handleApprovalDecision: (result: ApprovalResult) => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

export function useChatSession(deps: UseChatSessionDeps): UseChatSessionReturn {
  const {
    clientRef, workspaceIdRef, phaseRef, setPhase,
    agentName, autoApprove,
  } = deps;

  // --- State ---
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("normal");
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const [spinnerStatus, setSpinnerStatus] = useState<SpinnerStatus>(null);
  const [agentCwd, setAgentCwd] = useState<string | null>(() => {
    try { return processCwd(); } catch { return null; }
  });
  const [pendingApproval, setPendingApproval] = useState<{
    requests: ApprovalRequest[];
  } | null>(null);

  // --- Refs ---
  const threadRef = useRef(currentThreadId);
  threadRef.current = currentThreadId;
  const queueRef = useRef(messageQueue);
  queueRef.current = messageQueue;
  const execContextRef = useRef<ExecutionContext | null>(null);
  // drainQueueRef is kept as a ref so executeMessage can call the latest
  // drainQueue without listing it in its dependency array.
  const drainQueueRef = useRef<() => void>(() => {});

  // --- adapterCallbacks ---
  // Create once via useRef; the inner functions close over setState which is
  // stable. updateStats is a placeholder — wired from app.tsx after creation.
  const adapterCallbacks = useRef<TuiAdapterCallbacks>({
    addMessage: (msg) => {
      setMessages((prev) => [...prev, msg]);
    },
    updateMessage: (id, updates) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      );
    },
    updateToolCall: (_tool) => {
      // Tool calls stored inline in assistant messages for now.
    },
    setSpinner: (status) => {
      setSpinnerStatus(status);
    },
    updateStats: (_stats) => {
      // Wired from app.tsx after hook creation.
    },
    requestApproval: async (_toolName, _args) => {
      return "approve";
    },
    requestAskUser: async (_questions) => {
      return { type: "cancelled" as const };
    },
    onApprovalRequired: (_questions, actionRequests) => {
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
    onThreadResolved: (threadId) => {
      setCurrentThreadId(threadId);
    },
  });

  // --- Helpers ---

  const addAppMessage = useCallback((text: string) => {
    const msg: ChatMessageData = {
      id: `app_${Date.now()}`,
      role: "app",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  // --- Thread history ---

  const rowToMessage = useCallback((row: {
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
  }, []);

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
  }, [rowToMessage]);

  const loadMostRecentThread = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const threads = await client.listThreads();
      const wsId = workspaceIdRef.current;
      const scoped = wsId
        ? threads.filter((t) => t.workspaceId === wsId)
        : threads;
      if (scoped.length > 0 && scoped[0]) {
        await loadThreadHistory(scoped[0].id);
      }
    } catch (err) {
      logger.exception("Failed to load recent thread list", err);
    }
  }, [loadThreadHistory]);

  // --- Agent execution ---

  const executeMessage = useCallback(async (text: string, _mode: InputMode) => {
    const client = clientRef.current;
    if (!client) {
      addAppMessage("Error: No server connection.");
      setPhase("ready");
      return;
    }

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
      workspaceId: workspaceIdRef.current ?? undefined,
      agentName,
      autoApprove,
      abortSignal: abortController.signal,
    };
    execContextRef.current = execContext;

    try {
      await executeAgentTask(execContext, text);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        logger.exception("executeMessage failed", err);
        adapterCallbacks.current.onError((err as Error).message);
      }
    }

    // Only return to "ready" if we're not waiting on HITL approval.
    // Use a local flag captured by the functional setter to avoid
    // needing a separate ref mirror for pendingApproval.
    let wasBlocked = false;
    setPendingApproval((current) => {
      if (current) {
        wasBlocked = true;
        setPhase("blocked");
      } else {
        setPhase("ready");
        setSpinnerStatus(null);
      }
      return current;
    });

    // Drain queue if not blocked
    if (!wasBlocked) {
      drainQueueRef.current();
    }
  }, [agentName, autoApprove, addAppMessage, setPhase, phaseRef]);

  // --- Drain queue ---

  const drainQueue = useCallback(() => {
    const queued = queueRef.current;
    if (queued.length > 0) {
      const next = queued[0];
      setMessageQueue((prev) => prev.slice(1));
      executeMessage(next.text, next.mode);
    }
  }, [executeMessage]);

  drainQueueRef.current = drainQueue;

  // --- HITL approval ---

  const handleApprovalDecision = useCallback(async (result: ApprovalResult) => {
    // Don't show approval messages in the conversation — the approval
    // menu itself makes the action visible; echoing it adds noise.
    setPendingApproval(null);
    const ctx = execContextRef.current;
    if (!ctx || !ctx.threadId) {
      addAppMessage("无法恢复执行：没有活动会话。");
      setPhase("ready");
      return;
    }

    const isApproved = result.decision === "approve" || result.decision === "auto_approve";
    const requestCount = pendingApproval?.requests.length ?? 1;
    const resumeBody: ResumeRequestBody = {
      kind: "tool_approval",
      decisions: Array.from({ length: requestCount }, () =>
        isApproved
          ? { type: "approve" as const }
          : { type: "reject" as const, message: result.reason },
      ),
    };
    setPhase("running");
    try {
      await resumeAgentTask(ctx, resumeBody);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        logger.exception("handleApprovalDecision resume failed", err);
        adapterCallbacks.current.onError((err as Error).message);
      }
    }

    // After resume, check if there's a nested interrupt
    setPendingApproval((current) => {
      if (!current) {
        setPhase("ready");
        setSpinnerStatus(null);
        drainQueueRef.current();
      }
      return current;
    });
  }, [pendingApproval, addAppMessage, setPhase]);

  // --- Queue management ---

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

  return {
    messages, setMessages,
    currentThreadId, setCurrentThreadId,
    inputMode, setInputMode,
    messageQueue, setMessageQueue,
    spinnerStatus, setSpinnerStatus,
    agentCwd, setAgentCwd,
    adapterCallbacks,
    execContextRef,
    pendingApproval,
    addAppMessage,
    loadThreadHistory,
    loadMostRecentThread,
    executeMessage,
    drainQueue,
    enqueueOrExecute,
    handleApprovalDecision,
  };
}
