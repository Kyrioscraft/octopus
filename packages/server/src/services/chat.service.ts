/**
 * Chat service — agent stream orchestration.
 *
 * Consumes a LangGraph agent stream, translates raw graph events into NDJSON
 * StreamEvent chunks, persists messages, handles HITL interrupts and client
 * disconnects. Both the `POST /agent` and `POST /resume` routes delegate their
 * streaming work here — the route only creates the ReadableStream and passes
 * an `emit` callback (wrapping `controller.enqueue`).
 *
 * No HTTP/Hono dependency: the route owns the transport, the service owns the
 * business logic + protocol serialization.
 *
 * Equivalent to Python `chat_service.py::stream_agent_chat` / `stream_agent_resume`.
 */

import { v4 as uuid } from "uuid";
import { Command } from "@langchain/langgraph";
import {
  generateTitle,
  getLogger,
  wrapAgentStream,
} from "@octopus/core";
import type { SubagentRegistryEntry, AgentEvent } from "@octopus/core";
import { addMessage, addMessages, getMessages, mergeMessageExtra } from "../db/index.js";
import type { MessageRow } from "../db/index.js";

const logger = getLogger("chat.service");

// =============================================================================
// Types
// =============================================================================

/**
 * Transport-boundary events owned by this service layer (turn lifecycle, HITL
 * ask, /events control). Content events come from core's AgentEvent; both are
 * serialized as NDJSON `StreamEvent`s with a per-thread `seq` assigned by the
 * route's run-registry wrapper before enqueue/persist.
 */
export type BoundaryEvent =
  | { type: "turn.started"; threadId: string; requestId: string; runStartedAt: number; /** Fresh turns only (POST /agent); resume turns omit it and continue the same turn without a user bubble. */ userMessage?: string }
  | { type: "turn.finished"; threadId: string; title?: string; durationMs?: number }
  | { type: "thread.title.updated"; threadId: string; title: string }
  | { type: "turn.error"; errorType: string; message: string; threadId?: string }
  | { type: "turn.interrupted"; partialSaved: boolean; durationMs?: number }
  | { type: "ask"; kind: AskKind; questions: AskQuestion[]; thread_id: string }
  | { type: "idle"; threadId?: string }
  | { type: "heartbeat" };

/** Everything the service may emit on the wire (seq assigned downstream). */
export type WireEvent = AgentEvent | BoundaryEvent;

/** Emit a chunk to the client. The route wraps controller.enqueue here. */
export type Emit = (chunk: WireEvent) => void;

/** Input for a fresh chat turn. */
export interface ChatInput {
  threadId: string;
  userMessage: string;
  requestId: string;
  isNewThread: boolean;
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
  langgraphConfig: Record<string, unknown>;
  /** Model spec for title generation on new threads. */
  modelSpec?: string;
  /** Signal from the run registry — aborted by an explicit /stop request.
   *  Client disconnects do NOT abort the run (it continues in background). */
  abortSignal?: AbortSignal;
  /** Run start timestamp (run-registry startedAt) — used to compute and
   *  persist the turn's work duration ("已工作 Xm" indicator). */
  startedAt?: number;
}

/** Input for resuming a HITL-interrupted turn. */
export interface ResumeInput {
  threadId: string;
  requestId: string;
  /** Structured resume body (replaces the legacy `approved: boolean`). */
  resumeBody: ResumeRequestBody;
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
  langgraphConfig: Record<string, unknown>;
  /** Signal from the run registry — aborted by an explicit /stop request. */
  abortSignal?: AbortSignal;
  /** Run start timestamp — stamps work_duration_ms like streamChat. */
  startedAt?: number;
}


// =============================================================================
// Ask-the-user protocol types (mirror @octopus/tentacle — kept local to avoid
// a server → tentacle dependency, which would break the web→tentacle /
// server→core architecture boundary). These describe the wire shape of the
// `ask_user_question_required` chunk and the resume request body.
// =============================================================================

export type AskKind = "tool_approval" | "plan_approval" | "discussion" | "clarify";

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface AskQuestion {
  question_id: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  context?: {
    actionRequests?: Array<{
      name: string;
      args: Record<string, unknown>;
      description?: string;
    }>;
    source?: string;
    reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>;
  };
}

export interface AskUserQuestionPayload {
  kind: AskKind;
  questions: AskQuestion[];
  thread_id: string;
}

/**
 * Resume request body. Backwards-compatible: a legacy client sending only
 * `{ approved: boolean }` is folded into `kind: "tool_approval"` with a
 * single all-approve/all-reject decision list.
 */
export interface ResumeRequestBody {
  approved?: boolean;
  kind?: AskKind;
  /** plan_approval — revision feedback when the plan is rejected. */
  feedback?: string;
  decisions?: Array<
    | { type: "approve" }
    | { type: "always"; tool?: string }
    | { type: "reject"; message?: string }
    | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }
  >;
  answers?: Array<{
    question_id: string;
    selection?: string | string[];
    text?: string;
  }>;
}

// =============================================================================
// Persistence helpers (moved from chat.ts)
// =============================================================================

/** Persist user message to thread store. The optional agent name is stored
 *  in extraMetadata — message-level agent binding (phase 3 of the agent
 *  migration, mirroring opencode's per-message agent field). */
export function saveUserMessage(threadId: string, content: string, agent?: string): void {
  addMessage(threadId, {
    id: `msg_${Date.now()}`,
    role: "user",
    content,
    extraMetadata: agent ? { agent } : undefined,
    createdAt: new Date().toISOString(),
  });
}

/** Extract AI/tool messages from graph state and persist them. */
export function saveAiMessages(threadId: string, messages: any[]): void {
  // Build a set of message IDs already persisted so we skip re-inserting
  // messages from earlier turns that LangGraph still carries in state.
  const existingIds = new Set(getMessages(threadId).map((m) => m.id));
  const rows: MessageRow[] = [];
  for (const msg of messages) {
    const type = msg.type ?? msg._getType?.();
    // Skip messages that already exist in the DB (from previous turns).
    if (msg.id && existingIds.has(msg.id)) continue;
    if (type === "ai" || type === "AIMessage") {
      // Persist reasoning_content (additional_kwargs) so the web client can
      // restore the thinking trace after a refresh. Without this, reasoning is
      // only visible during the live stream and lost on reload.
      const reasoningContent = msg.additional_kwargs?.reasoning_content;
      rows.push({
        id: msg.id ?? `msg_${Date.now()}_${rows.length}`,
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        toolCalls: msg.tool_calls ?? undefined,
        extraMetadata: reasoningContent
          ? { additional_kwargs: { reasoning_content: reasoningContent } }
          : undefined,
        createdAt: new Date().toISOString(),
      });
    } else if (type === "tool" || type === "ToolMessage") {
      rows.push({
        id: msg.id ?? `msg_${Date.now()}_${rows.length}`,
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        extraMetadata: {
          tool_call_id: msg.tool_call_id,
          toolName: msg.name ?? "tool",
        },
        createdAt: new Date().toISOString(),
      });
    }
  }
  if (rows.length > 0) {
    addMessages(threadId, rows);
  }
}

/**
 * Persist partial assistant output when the client disconnects mid-stream
 * (user clicked stop) or the stream errors out. @returns true if saved.
 */
export function savePartialAssistantMessage(
  threadId: string,
  accumulatedContent: string,
  requestId: string,
): boolean {
  if (!accumulatedContent) return false;
  addMessage(threadId, {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: accumulatedContent,
    extraMetadata: {
      error_type: "interrupted",
      is_error: true,
      error_message: "对话已中断",
      request_id: requestId,
    },
    createdAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Stamp the finished turn's work duration (ms since run start) onto the
 * thread's LAST assistant message's extraMetadata (`work_duration_ms`), so
 * history reloads can render the frozen "已工作 Xm" indicator. Also returns
 * the duration so the `finished` chunk can carry it in meta.
 */
export function stampWorkDuration(
  threadId: string,
  startedAt: number | undefined,
): number | undefined {
  if (!startedAt) return undefined;
  const duration = Date.now() - startedAt;
  const last = [...getMessages(threadId)].reverse().find((m) => m.role === "assistant");
  if (last) {
    mergeMessageExtra(threadId, last.id, { work_duration_ms: duration });
  }
  return duration;
}

// =============================================================================
// Transport helpers
// =============================================================================
// NOTE: LangGraph chunk unpacking + text extraction moved to core's
// wrapAgentStream (engine.ts). The service consumes AgentEvent now and no
// longer touches LangChain message objects directly.

/**
 * Detect whether an error signals that the client closed the connection.
 * Hono/Node surfaces this several ways (AbortError, ERR_STREAM_DESTROYED,
 * "controller is already closed", connection reset, ...).
 */
export function isClientDisconnect(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: string } | null;
  if (!e) return false;
  const name = e.name ?? "";
  const code = e.code ?? "";
  const msg = e.message ?? "";
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_INVALID_STATE" ||
    msg.includes("aborted") ||
    msg.includes("controller is already closed") ||
    msg.includes("stream has been destroyed") ||
    (msg.includes("connection") && msg.includes("reset"))
  );
}

// =============================================================================
// HITL interrupt helpers (moved from chat.ts)
// =============================================================================

/** Extract the first interrupt info from a LangGraph state snapshot. */
export function extractInterruptInfo(state: any): any | null {
  if (state?.tasks && Array.isArray(state.tasks)) {
    for (const task of state.tasks) {
      if (task.interrupts && task.interrupts.length > 0) {
        return task.interrupts[0];
      }
    }
  }
  const values = state?.values ?? state ?? {};
  const interruptData = values.__interrupt__;
  if (Array.isArray(interruptData) && interruptData.length > 0) {
    return interruptData[0];
  }
  return null;
}

/** Count the number of interrupted action requests in an interrupt info. */
export function countInterruptedActions(interruptInfo: any): number {
  const value = interruptInfo?.value ?? interruptInfo;
  if (value && typeof value === "object") {
    const requests = value.actionRequests;
    if (Array.isArray(requests) && requests.length > 0) {
      return requests.length;
    }
  }
  return 1;
}

/**
 * Build the `ask_user_question_required` payload from an interrupt.
 *
 * Three `kind`:
 *   - tool_approval : LangChain humanInTheLoopMiddleware interrupt. The
 *     interrupt value carries `actionRequests` + `reviewConfigs`. We surface
 *     one question per actionRequest so the user can decide each tool
 *     independently (the old code applied one decision to all actions — a bug
 *     when multiple tools were batched). Options are derived from
 *     `reviewConfigs[].allowedDecisions` (approve/reject/edit), not hardcoded.
 *   - discussion / clarify : the agent's `ask_user_question` tool set
 *     `interrupt.value = { kind, questions: [...] }`. The questions already
 *     carry stable `question_id`s (assigned by the tool), so we pass them
 *     through verbatim — never regenerate ids, or resume can't pair answers.
 *
 * Discriminant priority: `value.kind` > has `actionRequests` → tool_approval
 * > has `options` → discussion > else clarify.
 */
export function buildAskPayload(
  interruptInfo: any,
  threadId: string,
): AskUserQuestionPayload {
  const value = interruptInfo?.value ?? interruptInfo ?? {};

  // --- Plan approval gate (submit_plan tool) ---
  if (value.kind === "plan_approval") {
    return {
      kind: "plan_approval",
      questions: [
        {
          question_id: `plan_${Date.now()}`,
          question: String(value.plan ?? ""),
          header: "计划审批",
        },
      ],
      thread_id: threadId,
    };
  }

  // --- Agent-initiated ask (ask_user_question tool) ---
  if (value.kind === "discussion" || value.kind === "clarify") {
    const questions: AskQuestion[] = Array.isArray(value.questions)
      ? value.questions.map((q: any) => ({
          question_id: String(q.question_id ?? `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          question: String(q.question ?? ""),
          ...(q.header ? { header: String(q.header) } : {}),
          ...(Array.isArray(q.options) ? { options: q.options } : {}),
          ...(typeof q.multi_select === "boolean" ? { multi_select: q.multi_select } : {}),
          ...(typeof q.allow_other === "boolean" ? { allow_other: q.allow_other } : {}),
        }))
      : [];
    return { kind: value.kind, questions, thread_id: threadId };
  }

  // --- Passive tool-call approval (humanInTheLoopMiddleware) ---
  const actionRequests: any[] = Array.isArray(value.actionRequests) ? value.actionRequests : [];
  const reviewConfigs: any[] = Array.isArray(value.reviewConfigs) ? value.reviewConfigs : [];

  if (actionRequests.length === 0) {
    // Defensive: an interrupt with neither kind nor actionRequests. Surface a
    // generic single-question approval so the client always has something to
    // render rather than hanging.
    return {
      kind: "tool_approval",
      questions: [
        {
          question_id: `ta_${uuid()}`,
          question: "工具调用需要批准",
          options: [
            { label: "批准", value: "approve" },
            { label: "拒绝", value: "reject" },
          ],
          context: { source: value.source ?? value.tool_name ?? "interrupt" },
        },
      ],
      thread_id: threadId,
    };
  }

  // One question per actionRequest so the user can decide each tool
  // independently. allowedDecisions come from reviewConfigs (default
  // approve/reject when unspecified); each becomes an option's value.
  const questions: AskQuestion[] = actionRequests.map((req: any, idx: number) => {
    const name = String(req.name ?? "unknown");
    const desc = typeof req.description === "string" ? req.description : undefined;
    const review = reviewConfigs[idx] ?? reviewConfigs.find((r: any) => r.actionName === name);
    const allowed: string[] =
      Array.isArray(review?.allowedDecisions) && review.allowedDecisions.length > 0
        ? review.allowedDecisions
        : ["approve", "reject"];
    const optionLabels: Record<string, string> = {
      approve: "批准",
      reject: "拒绝",
      edit: "编辑后批准",
    };
    return {
      question_id: `ta_${uuid()}`,
      question: desc ?? `批准执行: ${name}?`,
      header: name,
      options: allowed.map((d) => ({ label: optionLabels[d] ?? d, value: d })),
      multi_select: false,
      allow_other: false,
      context: {
        actionRequests: [req],
        source: name,
        reviewConfigs: review ? [review] : undefined,
      },
    };
  });

  return {
    kind: "tool_approval",
    questions,
    thread_id: threadId,
  };
}

/**
 * Normalize a ResumeRequestBody into the langgraph `Command({ resume })` value.
 *
 * - tool_approval → `{ decisions: [...] }` (one per actionRequest, in order).
 *   Legacy `{ approved }` is folded here: true → all approve, false → all reject.
 * - discussion / clarify → `{ answers: [...] }` passed straight through to the
 *   `ask_user_question` tool's `interrupt()` return value.
 */
export function normalizeResumeInput(
  body: ResumeRequestBody,
  actionCount: number,
): { decisions: Array<Record<string, unknown>> } | { answers: ResumeRequestBody["answers"] } | { approved: boolean; feedback?: string } {
  const kind = body.kind ?? (body.decisions ? "tool_approval" : body.answers ? "discussion" : "tool_approval");

  if (kind === "tool_approval") {
    // Pre-built decisions take priority; otherwise fold legacy `approved`.
    if (Array.isArray(body.decisions) && body.decisions.length > 0) {
      return { decisions: body.decisions };
    }
    const approved = body.approved !== false; // default true when unspecified
    const decisionType = approved ? "approve" : "reject";
    return {
      decisions: Array.from({ length: Math.max(actionCount, 1) }, () => ({ type: decisionType })),
    };
  }

  // plan_approval — the submit_plan tool's interrupt() expects
  // { approved, feedback? } as its resume value.
  if (kind === "plan_approval") {
    return { approved: body.approved !== false, feedback: body.feedback };
  }

  // discussion / clarify — answers flow back to the ask_user_question tool.
  return { answers: body.answers ?? [] };
}

/**
 * After streaming, check whether the graph stopped at a HITL interrupt and
 * emit `ask_user_question_required` if so. @returns true if an interrupt is pending.
 */
export async function checkAndHandleInterrupts(
  agent: any,
  langgraphConfig: Record<string, unknown>,
  threadId: string,
  emit: Emit,
): Promise<boolean> {
  try {
    const state = await agent.getState(langgraphConfig);
    if (!state?.values) return false;

    const interruptInfo = extractInterruptInfo(state);
    if (!interruptInfo) return false;

    const payload = buildAskPayload(interruptInfo, threadId);
    logger.info("HITL interrupt detected — emitting ask", {
      thread_id: threadId,
      kind: payload.kind,
      question_count: payload.questions.length,
    });
    emit({
      type: "ask",
      kind: payload.kind,
      questions: payload.questions,
      thread_id: threadId,
    });
    return true;
  } catch (err) {
    logger.exception("Failed to check interrupts", err);
    return false;
  }
}

// =============================================================================
// Stream processing core (shared by chat + resume)
// =============================================================================

/**
 * Translate one standardized AgentEvent into an emit() call and accumulate
 * assistant text for partial-save. Content events pass through verbatim — the
 * engine already emits the typed protocol shape; `seq` is assigned by the
 * route's run-registry wrapper.
 */
function processAgentEvent(
  event: AgentEvent,
  accumulate: (text: string) => void,
  emit: Emit,
): void {
  if (event.type === "text.delta") {
    accumulate(event.delta);
  }
  emit(event);
}

/**
 * Run a fresh chat turn to completion. Handles persistence, HITL, title
 * generation, and client disconnect. The route owns the ReadableStream; this
 * owns everything that happens inside it.
 */
export async function streamChat(
  input: ChatInput,
  emit: Emit,
  abortSignal?: AbortSignal,
): Promise<void> {
  let accumulatedContent = "";
  let clientAborted = false;
  const accumulate = (text: string) => { accumulatedContent += text; };

  try {
    // 1. turn.started
    emit({
      type: "turn.started",
      threadId: input.threadId,
      requestId: input.requestId,
      runStartedAt: input.startedAt ?? Date.now(),
      userMessage: input.userMessage,
    });

    // 1b. Auto-title a new thread's first turn IN THE BACKGROUND (opencode
    //     semantics: kicked off as the first LLM loop starts, not at turn end,
    //     so the sidebar shows a real title within seconds while the main
    //     model is still streaming). Failures are silent — the title simply
    //     stays "新对话" until the user renames it.
    if (input.isNewThread) {
      const fallbackTitle = input.userMessage.slice(0, 30);
      void (async () => {
        try {
          const generated = await generateTitle(input.userMessage, input.modelSpec);
          const title = generated ?? fallbackTitle;
          // Lazy import to avoid a circular dep at module load (thread.service is
          // pure db; importing its rename fn here keeps update local to this call).
          const { renameThread } = await import("./thread.service.js");
          renameThread(input.threadId, title);
          logger.info(`Auto-titled thread ${input.threadId}: "${title}"`);
          // Push to live subscribers AND the replayable event log — the sidebar
          // updates without waiting for turn.finished / listThreads() refresh.
          emit({ type: "thread.title.updated", threadId: input.threadId, title });
        } catch (err) {
          logger.exception("Auto title generation failed", err);
        }
      })();
    }

    // 2. Stream graph (via standardized AgentEvent — no LangGraph coupling here)
    try {
      const eventStream = await input.agent.stream(
        { messages: [{ role: "user", content: input.userMessage }] },
        {
          ...input.langgraphConfig,
          streamMode: ["messages" as const],
          ...(abortSignal ? { signal: abortSignal } : {}),
        },
      );

      const agentEvents = wrapAgentStream(eventStream, {
        subagentRegistry: input.subagentRegistry,
      });
      for await (const event of agentEvents) {
        processAgentEvent(event, accumulate, emit);
      }
    } catch (streamErr: any) {
      const isInterrupt =
        streamErr?.name === "GraphInterrupt" ||
        streamErr?.message?.includes?.("interrupt") ||
        streamErr?.constructor?.name === "GraphInterrupt";

      if (isClientDisconnect(streamErr)) {
        // Distinguish an explicit /stop (registry AbortController aborted)
        // from an HTTP-connection cancellation that propagated into the
        // LangGraph stream (Node/Hono wires the request signal into
        // agent.stream). Only an explicit stop interrupts the run; a client
        // disconnect must let the run finish in the background (events keep
        // flowing into the run registry, persistence + finished still run —
        // enqueue failures are swallowed by the route's makeRunEmit).
        if (abortSignal?.aborted) {
          clientAborted = true;
          const saved = savePartialAssistantMessage(input.threadId, accumulatedContent, input.requestId);
          const durationMs = stampWorkDuration(input.threadId, input.startedAt);
          emit({
            type: "turn.interrupted",
            partialSaved: saved,
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
          logger.info(`Run aborted by stop request${saved ? " (partial saved)" : ""}`, {
            thread_id: input.threadId,
            request_id: input.requestId,
          });
        } else {
          logger.info("Client disconnected — run continues in background", {
            thread_id: input.threadId,
            request_id: input.requestId,
          });
        }
        // Both fall through to the post-stream path (persist + interrupt
        // check + finished). For a disconnect the run already completed its
        // final state in the graph; for a stop the state is what it was.
      } else if (!isInterrupt) {
        const isDeserError =
          streamErr?.message?.includes?.("deserialize") ||
          streamErr?.message?.includes?.("unknown variant") ||
          streamErr?.message?.includes?.("expected `text`");
        if (isDeserError) {
          logger.warn(
            `Legacy deserialization error in thread ${input.threadId} — ` +
              "checkpoint contains content types the backend can't read. " +
              "Start a new thread to clear it.",
            { error: String(streamErr).slice(0, 200) },
          );
        }
        throw streamErr;
      }
      // Interrupt — fall through to check state below.
    }

    // 3. Persist AI messages (skip on abort — partial already saved).
    if (!clientAborted) {
      try {
        const state = await input.agent.getState(input.langgraphConfig);
        const stateMessages = state?.values?.messages ?? [];
        saveAiMessages(input.threadId, stateMessages);
      } catch (err) {
        logger.exception("Failed to save AI messages", err);
      }
    }

    // 4. Check for HITL interrupt
    const hasInterrupt = await checkAndHandleInterrupts(
      input.agent, input.langgraphConfig, input.threadId, emit,
    );

    // 5. Title for a new thread's first turn is generated by the background
    //    task kicked off at turn start (1b above) — the DB is already updated
    //    and a thread.title.updated event was emitted by the time we get here
    //    (or shortly after). No synchronous work needed at turn end.

    // 6. Emit finished. Interrupted turns don't emit finished — the turn
    //    isn't done. Title for new threads arrives via the background
    //    thread.title.updated event (1b), not here.
    //    Stamp the work duration onto the last assistant message first (the
    //    "已工作 Xm" indicator survives history reloads).
    const durationMs = stampWorkDuration(input.threadId, input.startedAt);
    if (!hasInterrupt) {
      emit({
        type: "turn.finished",
        threadId: input.threadId,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  } catch (err) {
    if (isClientDisconnect(err)) {
      if (abortSignal?.aborted) {
        // Explicit stop — only this path persists partial + notifies.
        if (accumulatedContent && !clientAborted) {
          savePartialAssistantMessage(input.threadId, accumulatedContent, input.requestId);
        }
        const durationMs = stampWorkDuration(input.threadId, input.startedAt);
        emit({
          type: "turn.interrupted",
          partialSaved: accumulatedContent.length > 0,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
        logger.info(`Run aborted (outer)`, {
          thread_id: input.threadId,
          request_id: input.requestId,
        });
      } else {
        // Connection cancellation reached the outer loop — the run is over
        // from our perspective; nothing more to do (events were recorded).
        logger.info("Client disconnected (outer) — run already recorded", {
          thread_id: input.threadId,
          request_id: input.requestId,
        });
      }
    } else {
      logger.exception("Agent stream failed", err);
      emit({
        type: "turn.error",
        errorType: "agent_error",
        message: err instanceof Error ? err.message : "未知错误",
        threadId: input.threadId,
      });
    }
  }
}

/**
 * Resume a HITL-interrupted turn. Shares the chunk-translation core with
 * streamChat; differs in entry (Command resume) and has no title generation.
 */
export async function streamResume(
  input: ResumeInput,
  emit: Emit,
  abortSignal?: AbortSignal,
): Promise<void> {
  // Step 1: Read pre-state to count interrupted actions.
  let actionCount = 1;
  try {
    const preState = await input.agent.getState(input.langgraphConfig);
    if (preState) {
      const interruptInfo = extractInterruptInfo(preState);
      if (interruptInfo) {
        actionCount = countInterruptedActions(interruptInfo);
      } else {
        logger.warn("Resume called but no interrupt found in state", {
          thread_id: input.threadId,
        });
      }
    }
  } catch (err) {
    logger.exception("Failed to read pre-state for resume", err);
  }

  // Step 2: Normalize resume input.
  const normalizedResume = normalizeResumeInput(input.resumeBody, actionCount);
  const resumeCommand = new Command({ resume: normalizedResume });
  logger.info("Resume sending", {
    thread_id: input.threadId,
    kind: input.resumeBody.kind ?? "tool_approval",
    resume_keys: Object.keys(normalizedResume),
  });

  try {
    // Resume continues the SAME turn — no synthetic user bubble. The boundary
    // event carries no userMessage; clients render a user bubble only when
    // turn.started.userMessage is present (a fresh turn from POST /agent).
    emit({
      type: "turn.started",
      threadId: input.threadId,
      requestId: input.requestId,
      runStartedAt: input.startedAt ?? Date.now(),
    });

    // Step 3: Stream the resumed graph (standardized AgentEvent).
    try {
      const eventStream = await input.agent.stream(resumeCommand, {
        ...input.langgraphConfig,
        streamMode: ["messages" as const],
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      const agentEvents = wrapAgentStream(eventStream, {
        subagentRegistry: input.subagentRegistry,
      });
      // Resume skips the accumulation/partial-save path (state was already
      // persisted by the interrupt). Use a no-op accumulate.
      for await (const event of agentEvents) {
        processAgentEvent(event, () => {}, emit);
      }
    } catch (streamErr: any) {
      const isInterrupt =
        streamErr?.name === "GraphInterrupt" ||
        streamErr?.message?.includes?.("interrupt") ||
        streamErr?.constructor?.name === "GraphInterrupt";
      if (isClientDisconnect(streamErr)) {
        // Explicit /stop → notify listeners; plain disconnect → the run's
        // events are already recorded, finish silently.
        if (abortSignal?.aborted) {
          emit({
            type: "turn.interrupted",
            partialSaved: false,
          });
        }
      } else if (!isInterrupt) throw streamErr;
    }

    // Step 4: Persist AI messages.
    try {
      const state = await input.agent.getState(input.langgraphConfig);
      const stateMessages = state?.values?.messages ?? [];
      saveAiMessages(input.threadId, stateMessages);
    } catch (err) {
      logger.exception("Failed to save AI messages on resume", err);
    }

    // Step 5: Check for nested interrupts.
    const hasInterrupt = await checkAndHandleInterrupts(
      input.agent, input.langgraphConfig, input.threadId, emit,
    );

    if (!hasInterrupt) {
      const durationMs = stampWorkDuration(input.threadId, input.startedAt);
      emit({
        type: "turn.finished",
        threadId: input.threadId,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  } catch (err) {
    logger.exception("Agent stream failed", err);
    emit({
      type: "turn.error",
      errorType: "agent_error",
      message: err instanceof Error ? err.message : "未知错误",
      threadId: input.threadId,
    });
  }
}
