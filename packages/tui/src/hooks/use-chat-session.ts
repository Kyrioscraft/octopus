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
  SessionState, AgentBlock, BlockId, BlockStreamCallbacks,
  AskUserAnswerEntry, TodoItem, Turn,
} from "../types.js";
import { TuiClient } from "../client/client.js";
import type { ResumeRequestBody } from "../client/client.js";
import { executeAgentTask, resumeAgentTask } from "../core/tui-adapter.js";
import type { TuiAdapterCallbacks, ExecutionContext } from "../core/tui-adapter.js";
import { mapStreamToBlocks } from "../core/block-stream.js";
import type { InterruptContext } from "../core/block-stream.js";
import { useTextBuffer } from "./use-text-buffer.js";
import type { ApprovalRequest, ApprovalResult } from "../components/approval.js";
import { getLogger } from "../utils/logging.js";

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
  /** Block-level session state (new block rendering model). */
  sessionState: SessionState;
  /** Execute a user message using the block-level rendering path. */
  executeMessageAsBlocks: (text: string, mode: InputMode) => Promise<void>;
  /** Resolve a pending confirm block (called when user presses y/n). */
  handleConfirmAnswer: (approved: boolean) => void;
  /** Current ask_user questions (non-null triggers AskUserMenu). */
  askUserQuestions: Array<Record<string, unknown>> | null;
  /** Handle ask_user answer submission. */
  handleAskUserAnswer: (answers: AskUserAnswerEntry[]) => void;
  /** Todo list from write_todos (persistent widget). */
  todos: TodoItem[];
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

  // --- Block-level state (new rendering model per architecture/tui-solution.md) ---
  const [sessionState, setSessionState] = useState<SessionState>({
    turns: [],
    pendingConfirm: null,
  });
  // Resolver for the confirm Promise — set when a confirm block is pending.
  const confirmResolveRef = useRef<((approved: boolean) => void) | null>(null);

  // Ask_user panel state — non-null triggers AskUserMenu in MainScreen.
  const [askUserQuestions, setAskUserQuestions] = useState<Array<Record<string, unknown>> | null>(null);
  // Resolver for the ask_user answer Promise.
  const askUserResolveRef = useRef<((answers: AskUserAnswerEntry[]) => void) | null>(null);
  // Track the thread ID resolved during streaming (for resume calls).
  const blockThreadIdRef = useRef<string | null>(null);

  // Todo list from write_todos tool (persistent widget, not tool blocks)
  const [todos, setTodos] = useState<TodoItem[]>([]);

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
    insertMessage: (msg, beforeId) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === beforeId);
        if (idx >= 0) {
          const copy = [...prev];
          copy.splice(idx, 0, msg);
          return copy;
        }
        return [...prev, msg];
      });
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

  // ===========================================================================
  // Block-level helpers — drive the SessionState from BlockStreamCallbacks
  // ===========================================================================

  /** Generate a unique block ID. */
  const makeBlockId = useCallback((prefix: string): BlockId => {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }, []);

  /** Add a block to the last (assistant) turn. */
  const addBlock = useCallback((block: AgentBlock) => {
    setSessionState((prev) => {
      const turns = [...prev.turns];
      if (turns.length === 0) return prev;
      const lastTurn = { ...turns[turns.length - 1]! };
      lastTurn.blocks = [...lastTurn.blocks, block];
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  }, []);

  /** Update an existing block by ID in the last turn. */
  const updateBlock = useCallback((id: BlockId, patch: Partial<AgentBlock>) => {
    setSessionState((prev) => {
      const turns = [...prev.turns];
      if (turns.length === 0) return prev;
      const lastTurn = { ...turns[turns.length - 1]! };
      lastTurn.blocks = lastTurn.blocks.map((b) =>
        b.id === id ? { ...b, ...patch } as AgentBlock : b,
      );
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  }, []);

  /** Remove a block by ID from the last turn. */
  const removeBlock = useCallback((id: BlockId) => {
    setSessionState((prev) => {
      const turns = [...prev.turns];
      if (turns.length === 0) return prev;
      const lastTurn = { ...turns[turns.length - 1]! };
      lastTurn.blocks = lastTurn.blocks.filter((b) => b.id !== id);
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  }, []);

  // --- Text buffer for rAF-throttled streaming ---
  const textBuffer = useTextBuffer((updates) => {
    setSessionState((prev) => {
      const turns = [...prev.turns];
      if (turns.length === 0) return prev;
      const lastTurn = { ...turns[turns.length - 1]! };
      lastTurn.blocks = lastTurn.blocks.map((b) => {
        if (b.type === "text" && updates.has(b.id)) {
          const delta = updates.get(b.id) ?? "";
          return { ...b, content: b.content + delta } as AgentBlock;
        }
        return b;
      });
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  });

  // --- BlockStreamCallbacks ---

  /**
   * Finalize all active blocks of a given type in the last turn.
   * Ensures at most one block type is active at a time — when a new type
   * starts (e.g. text after thinking), the previous one is auto-frozen so
   * the active zone always has the latest activity at the bottom.
   */
  const finalizeActiveOfType = useCallback((blockType: AgentBlock["type"]) => {
    setSessionState((prev) => {
      const turns = [...prev.turns];
      if (turns.length === 0) return prev;
      const lastTurn = { ...turns[turns.length - 1]! };
      let changed = false;
      lastTurn.blocks = lastTurn.blocks.map((b) => {
        if (b.type === blockType && !(b.type === "confirm"
          ? b.status === "approved" || b.status === "rejected"
          : b.status === "done")) {
          changed = true;
          return { ...b, status: "done" } as AgentBlock;
        }
        return b;
      });
      if (!changed) return prev;
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  }, []);

  const blockCallbacks = useRef<BlockStreamCallbacks>({
    onThinkingStart: (id) => {
      // Thinking starts a new reasoning cycle — finalize any active text
      finalizeActiveOfType("text");
      addBlock({ id, type: "thinking", status: "running" });
    },
    onThinkingEnd: (id, content) => {
      updateBlock(id, { status: "done", content } as Partial<AgentBlock>);
    },
    onTextStart: (id) => {
      // Text follows thinking — finalize active thinking
      finalizeActiveOfType("thinking");
      addBlock({ id, type: "text", status: "streaming", content: "" });
    },
    onTextDelta: (id, token) => {
      textBuffer.push(id, token);
    },
    onTextEnd: (id) => {
      textBuffer.flush();
      updateBlock(id, { status: "done" } as Partial<AgentBlock>);
    },
    onToolStart: (id, tool, input) => {
      finalizeActiveOfType("text");
      finalizeActiveOfType("thinking");
      addBlock({ id, type: "tool_call", status: "running", tool, input });
    },
    onToolPending: (id, tool, input) => {
      // Pending tool — shown dimmed without spinner, waiting its turn
      addBlock({ id, type: "tool_call", status: "pending", tool, input });
    },
    onToolPromote: (id) => {
      // Promote pending → running when it's this tool's turn
      updateBlock(id, { status: "running" } as Partial<AgentBlock>);
    },
    onToolEnd: (id, output, error) => {
      updateBlock(id, { status: "done", output, error } as Partial<AgentBlock>);
    },
    onTodosUpdate: (items) => {
      setTodos(items);
    },
    onConfirm: async (id, message, action) => {
      addBlock({ id, type: "confirm", status: "pending", message, action });
      setSessionState((prev) => ({ ...prev, pendingConfirm: id }));
      setPhase("blocked");
      // Return a Promise that resolves when the user presses y/n.
      return new Promise<boolean>((resolve) => {
        confirmResolveRef.current = (approved: boolean) => {
          setSessionState((prev) => ({
            ...prev,
            pendingConfirm: null,
          }));
          if (approved) {
            updateBlock(id, { status: "approved" } as Partial<AgentBlock>);
          } else {
            updateBlock(id, { status: "rejected" } as Partial<AgentBlock>);
          }
          resolve(approved);
        };
      });
    },
    onTurnStart: () => {
      setTodos([]); // Clear previous turn's todos
      setSessionState((prev) => ({
        ...prev,
        turns: [
          ...prev.turns,
          {
            id: `turn_${Date.now()}`,
            role: "assistant",
            blocks: [],
            finished: false,
          },
        ],
      }));
    },
    onTurnEnd: () => {
      setSessionState((prev) => {
        const turns = [...prev.turns];
        if (turns.length > 0) {
          turns[turns.length - 1] = { ...turns[turns.length - 1]!, finished: true };
        }
        return { ...prev, turns };
      });
    },
  });

  // --- Thread history ---

  /** Shape of a single message row returned by `getThreadHistory`. The TUI
   *  client wrapper declares a narrow type, but the underlying OctopusClient
   *  returns the full MessageRow — we accept the superset defensively. */
  type HistoryRow = {
    id: string;
    role: string;
    content: string;
    toolCalls?: unknown;
    extraMetadata?: Record<string, unknown>;
    createdAt: string;
  };

  /**
   * Rebuild block-level `Turn[]` from persisted message rows so that the
   * block-rendering path (useBlockRendering = true) can display restored
   * history. Each user message becomes a user turn; each assistant message
   * becomes an assistant turn (with an optional tool_call block if the row
   * carried toolCalls). Non user/assistant rows (tool, app, …) are folded
   * into the preceding assistant turn as extra blocks when possible.
   */
  const messagesToTurns = useCallback((rows: HistoryRow[]): Turn[] => {
    const turns: Turn[] = [];
    for (const row of rows) {
      const role = row.role;
      const blockId = `${role}_${row.id}`;

      if (role === "user") {
        turns.push({
          id: `turn_${row.id}`,
          role: "user",
          finished: true,
          blocks: [{
            id: blockId,
            type: "text",
            status: "done",
            content: row.content ?? "",
          }],
        });
      } else {
        // assistant / tool / other → attach to an assistant turn.
        const blocks: AgentBlock[] = [];

        // Tool rows carry the tool result; surface as a tool_call block.
        if (role === "tool") {
          blocks.push({
            id: blockId,
            type: "tool_call",
            status: "done",
            tool: (row.extraMetadata?.["toolName"] as string) ?? "tool",
            input: {},
            output: row.content ?? "",
          });
        } else {
          // assistant text (skip empty placeholder assistant messages)
          const text = row.content ?? "";
          if (text) {
            blocks.push({
              id: blockId,
              type: "text",
              status: "done",
              content: text,
            });
          }
          // Attach tool calls if the row carried them.
          if (row.toolCalls && Array.isArray(row.toolCalls)) {
            for (const tc of row.toolCalls as Record<string, unknown>[]) {
              blocks.push({
                id: `${blockId}_tc_${String(tc["id"] ?? Math.random().toString(36).slice(2))}`,
                type: "tool_call",
                status: "done",
                tool: (tc["name"] as string) ?? "tool",
                input: (tc["args"] as Record<string, unknown>) ?? {},
                output: typeof tc["result"] === "string" ? tc["result"] : undefined,
              });
            }
          }
        }

        // Only push a turn if we produced any renderable blocks.
        if (blocks.length === 0) continue;

        // If the previous turn is an unfinished assistant turn, merge into it;
        // otherwise start a new assistant turn.
        const last = turns[turns.length - 1];
        if (last && last.role === "assistant") {
          last.blocks = [...last.blocks, ...blocks];
        } else {
          turns.push({
            id: `turn_${row.id}`,
            role: "assistant",
            finished: true,
            blocks,
          });
        }
      }
    }
    return turns;
  }, []);

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
      // Rebuild block-level turns so the block-rendering path (the default)
      // renders restored history alongside the legacy `messages` array.
      setSessionState({ turns: messagesToTurns(history), pendingConfirm: null });
    } catch (err) {
      logger.exception(`Failed to load history for thread ${threadId}`, err);
    }
  }, [rowToMessage, messagesToTurns]);

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
    // Create a placeholder assistant message immediately so the inline
    // "Thinking..." indicator appears in the conversation flow right away,
    // rather than showing a separate bottom-anchored spinner.
    const assistantMsgId = `msg_${Date.now() + 1}`;
    const assistantMsg: ChatMessageData = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      metadata: { finalized: false },
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
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
      assistantMessageId: assistantMsgId,
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

  // --- Block-level agent execution ---

  /**
   * Process a stream and handle interrupts.
   * Returns the next interrupt or null if the stream completed.
   */
  const processStream = useCallback(async (
    client: TuiClient,
    stream: AsyncGenerator<import("@octopus/tentacle").StreamEvent>,
    signal: AbortSignal,
  ): Promise<InterruptContext | null> => {
    return await mapStreamToBlocks(stream, blockCallbacks.current, signal);
  }, []);

  const executeMessageAsBlocks = useCallback(async (text: string, _mode: InputMode) => {
    const client = clientRef.current;
    if (!client) {
      addAppMessage("Error: No server connection.");
      setPhase("ready");
      return;
    }

    // Add user turn
    const userTurnId = `turn_${Date.now()}`;
    setSessionState((prev) => ({
      ...prev,
      turns: [
        ...prev.turns,
        {
          id: userTurnId,
          role: "user",
          blocks: [
            {
              id: `user_${Date.now()}`,
              type: "text",
              status: "done",
              content: text,
            },
          ],
          finished: true,
        },
      ],
    }));

    // Also add to the message-based history for thread persistence
    const userMsg: ChatMessageData = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setPhase("running");
    setSpinnerStatus("Thinking");

    const abortController = new AbortController();

    try {
      // Start the initial stream
      const stream = await client.streamChat(
        {
          messages: [{ role: "user", content: text }],
          thread_id: threadRef.current ?? undefined,
          workspace_id: workspaceIdRef.current ?? undefined,
          mode: "auto",
          request_id: `req_${Date.now()}`,
        },
        { signal: abortController.signal },
      );

      let interrupt = await processStream(client, stream, abortController.signal);

      // ── Interrupt loop: handle confirm / ask_user, then resume ──
      while (interrupt) {
        if (interrupt.kind === "confirm") {
          // Wait for user to press y/n (handleConfirmAnswer resolves the Promise)
          const approved = await interrupt.confirmPromise;

          if (!approved) {
            // User rejected — don't resume, end the turn
            setPhase("ready");
            setSpinnerStatus(null);
            break;
          }

          // Resume with approval
          setPhase("running");
          setSpinnerStatus("Thinking");

          const resumeStream = await client.streamResume(
            interrupt.threadId ?? threadRef.current ?? "",
            {
              kind: "tool_approval",
              decisions: interrupt.actionRequests.map(() => ({
                type: "approve" as const,
              })),
            },
            { signal: abortController.signal },
          );

          interrupt = await processStream(client, resumeStream, abortController.signal);

        } else if (interrupt.kind === "ask_user") {
          // Show ask_user panel, wait for answers
          setAskUserQuestions(interrupt.questions);
          setPhase("blocked");

          // Create a Promise that resolves when the user submits answers
          const answers = await new Promise<AskUserAnswerEntry[]>((resolve) => {
            askUserResolveRef.current = resolve;
          });

          setAskUserQuestions(null);
          setPhase("running");
          setSpinnerStatus("Thinking");

          // Resume with answers
          const resumeStream = await client.streamResume(
            interrupt.threadId ?? threadRef.current ?? "",
            { answers },
            { signal: abortController.signal },
          );

          interrupt = await processStream(client, resumeStream, abortController.signal);
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // User cancelled
      } else {
        logger.exception("executeMessageAsBlocks failed", err);
        setSessionState((prev) => {
          const turns = [...prev.turns];
          if (turns.length > 0) {
            const lastTurn = { ...turns[turns.length - 1]! };
            lastTurn.blocks = [
              ...lastTurn.blocks,
              {
                id: `err_${Date.now()}`,
                type: "text",
                status: "done",
                content: `Error: ${(err as Error).message}`,
              },
            ];
            turns[turns.length - 1] = lastTurn;
          }
          return { ...prev, turns };
        });
      }
    }

    // Final state check — done outside setSessionState to avoid side-effects in updater
    // We need to read the current session state to check pendingConfirm
    let isBlocked = false;
    setSessionState((prev) => {
      if (prev.pendingConfirm) {
        isBlocked = true;
      }
      return prev;
    });

    if (!isBlocked) {
      setPhase("ready");
      setSpinnerStatus(null);
      // Drain queue
      const queued = queueRef.current;
      if (queued.length > 0) {
        const next = queued[0]!;
        setMessageQueue((p) => p.slice(1));
        setTimeout(() => executeMessageAsBlocks(next.text, next.mode), 0);
      }
    }
  }, [agentName, addAppMessage, setPhase, phaseRef, processStream]);

  /** Resolve a pending confirm block (called when user presses y/n). */
  const handleConfirmAnswer = useCallback((approved: boolean) => {
    if (confirmResolveRef.current) {
      const resolve = confirmResolveRef.current;
      confirmResolveRef.current = null;
      resolve(approved);
      // Don't set phase here — the executeMessageAsBlocks loop handles it
    }
  }, []);

  /** Handle ask_user answer submission. */
  const handleAskUserAnswer = useCallback((answers: AskUserAnswerEntry[]) => {
    if (askUserResolveRef.current) {
      const resolve = askUserResolveRef.current;
      askUserResolveRef.current = null;
      resolve(answers);
    }
  }, []);

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
    sessionState,
    executeMessageAsBlocks,
    handleConfirmAnswer,
    askUserQuestions,
    handleAskUserAnswer,
    todos,
  };
}
