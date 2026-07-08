import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { Command } from "@langchain/langgraph";
import { getOptionalUser } from "../auth/middleware.js";
import { createAgent, loadConfig, getLogger, getLogContext } from "@octopus/core";
import {
  createThread,
  getThread,
  listThreads,
  updateThreadTitle,
  deleteThread,
  addMessage,
  addMessages,
} from "../db/index.js";
import type { MessageRow } from "../db/index.js";

export const chatRouter = new Hono();

const logger = getLogger("chat.router");

// =============================================================================
// Helpers
// =============================================================================

const encoder = new TextEncoder();
const makeChunk = (payload: Record<string, unknown>): Uint8Array =>
  encoder.encode(JSON.stringify(payload) + "\n");

/** Persist user message to thread store. */
function saveUserMessage(threadId: string, content: string): void {
  addMessage(threadId, {
    id: `msg_${Date.now()}`,
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  });
}

/** Extract AI/tool messages from graph state and persist them. */
function saveAiMessages(threadId: string, messages: any[]): void {
  const rows: MessageRow[] = [];
  for (const msg of messages) {
    const type = msg.type ?? msg._getType?.();
    if (type === "ai" || type === "AIMessage") {
      rows.push({
        id: msg.id ?? `msg_${Date.now()}_${rows.length}`,
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        toolCalls: msg.tool_calls ?? undefined,
        createdAt: new Date().toISOString(),
      });
    } else if (type === "tool" || type === "ToolMessage") {
      rows.push({
        id: msg.id ?? `msg_${Date.now()}_${rows.length}`,
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        extraMetadata: { tool_call_id: msg.tool_call_id },
        createdAt: new Date().toISOString(),
      });
    }
  }
  if (rows.length > 0) {
    addMessages(threadId, rows);
  }
}

// =============================================================================
// HITL interrupt helpers — mirrors Python `chat_service.py` logic
// =============================================================================

/**
 * Extract the first interrupt info from a LangGraph state snapshot.
 *
 * LangGraph stores interrupts either in `state.tasks[].interrupts[]` (Pregel
 * task model) or in `state.values.__interrupt__[]` (raw state channel).
 * Each interrupt entry carries a `.value` which deepagents sets to a
 * `HITLRequest` dict: `{ action_requests: [...], review_configs: [...] }`.
 */
function extractInterruptInfo(state: any): any | null {
  // Path 1: PregelState.tasks[].interrupts[]
  if (state?.tasks && Array.isArray(state.tasks)) {
    for (const task of state.tasks) {
      if (task.interrupts && task.interrupts.length > 0) {
        return task.interrupts[0];
      }
    }
  }
  // Path 2: state.values.__interrupt__[]
  const values = state?.values ?? state ?? {};
  const interruptData = values.__interrupt__;
  if (Array.isArray(interruptData) && interruptData.length > 0) {
    return interruptData[0];
  }
  return null;
}

/**
 * Count how many tool calls are awaiting a HITL decision.
 *
 * deepagents' HITL middleware stores `{ action_requests: [...] }` as the
 * interrupt value. Each entry needs a matching `decisions` entry on resume.
 */
function countInterruptedActions(interruptInfo: any): number {
  const value = interruptInfo?.value ?? interruptInfo;
  if (value && typeof value === "object") {
    const requests = value.action_requests;
    if (Array.isArray(requests) && requests.length > 0) {
      return requests.length;
    }
  }
  return 1;
}

/**
 * Build the `ask_user_question_required` payload from an interrupt.
 */
function buildHITLQuestions(interruptInfo: any, threadId: string): Record<string, unknown> {
  const value = interruptInfo?.value ?? interruptInfo ?? {};
  const source = value.source ?? value.tool_name ?? "interrupt";

  // Try to get meaningful question text
  let questionText = "工具调用需要批准";
  const actionRequests: any[] = value.action_requests ?? [];
  if (actionRequests.length > 0) {
    const names = actionRequests
      .map((a: any) => a.name ?? a.tool_name ?? "unknown")
      .join(", ");
    questionText = `批准执行: ${names}?`;
  } else if (value.question) {
    questionText = String(value.question);
  }

  return {
    questions: [
      {
        question_id: uuid(),
        question: questionText,
        options: [
          { label: "批准", value: "approve" },
          { label: "拒绝", value: "reject" },
        ],
        multi_select: false,
        allow_other: false,
      },
    ],
    source,
    thread_id: threadId,
  };
}

/**
 * Normalize resume input into the `{ decisions: [...] }` shape that
 * deepagents' HITL middleware expects.
 *
 * Each tool call awaiting approval needs a corresponding entry in the
 * decisions list. The middleware validates exact length match.
 */
function normalizeResumeInput(
  approved: boolean,
  actionCount: number
): { decisions: Array<{ type: string }> } {
  const decisionType = approved ? "approve" : "reject";
  return {
    decisions: Array.from({ length: Math.max(actionCount, 1) }, () => ({
      type: decisionType,
    })),
  };
}

/**
 * After streaming, check whether the graph stopped at a HITL interrupt and
 * emit `ask_user_question_required` if so.
 *
 * Ported from Python `chat_service.py::check_and_handle_interrupts`.
 */
async function checkAndHandleInterrupts(
  agent: any,
  langgraphConfig: Record<string, unknown>,
  threadId: string,
  controller: ReadableStreamDefaultController
): Promise<boolean> {
  try {
    const state = await agent.getState(langgraphConfig);
    if (!state?.values) return false;

    const interruptInfo = extractInterruptInfo(state);
    if (!interruptInfo) return false;

    const payload = buildHITLQuestions(interruptInfo, threadId);
    controller.enqueue(
      makeChunk({
        status: "ask_user_question_required",
        ...payload,
        meta: { thread_id: threadId, interrupt: payload },
      })
    );
    return true;
  } catch (err) {
    logger.exception("Failed to check interrupts", err);
    return false;
  }
}

// =========================================================================
// GET /api/chat/threads
// =========================================================================

chatRouter.get("/threads", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const threads = listThreads(userId).map(({ messages: _m, ...rest }) => rest);
  return c.json({ threads });
});

// =========================================================================
// GET /api/chat/thread/{id}/history
// =========================================================================

chatRouter.get("/thread/:id/history", getOptionalUser, (c) => {
  const threadId = c.req.param("id");
  const thread = getThread(threadId);
  if (!thread) return c.json({ detail: "会话不存在" }, 404);
  return c.json({ history: thread.messages });
});

// =========================================================================
// DELETE /api/chat/thread/{id}
// =========================================================================

chatRouter.delete("/thread/:id", getOptionalUser, (c) => {
  deleteThread(c.req.param("id"));
  return c.json({ success: true });
});

// =========================================================================
// PUT /api/chat/thread/{id}
// =========================================================================

chatRouter.put("/thread/:id", getOptionalUser, async (c) => {
  const threadId = c.req.param("id");
  const { title } = await c.req.json<{ title: string }>();
  const updated = updateThreadTitle(threadId, title ?? "新对话");
  if (!updated) return c.json({ detail: "会话不存在" }, 404);
  return c.json({ success: true, title: updated.title });
});

// =========================================================================
// POST /api/chat/agent
// =========================================================================

interface ChatRequest {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  thread_id?: string;
  agent_id?: string;
}

chatRouter.post("/agent", getOptionalUser, async (c) => {
  const body = await c.req.json<ChatRequest>();
  const userId = c.var.user.sub;
  const userMessage = body.messages?.at(-1)?.content ?? "";
  const requestId = getLogContext()?.request_id ?? uuid().slice(0, 8);
  let threadId = body.thread_id;
  if (!threadId) {
    threadId = `thread_${uuid()}`;
    createThread({ id: threadId, userId, agentId: body.agent_id });
  } else if (!getThread(threadId)) {
    createThread({ id: threadId, userId, agentId: body.agent_id });
  }

  // Persist user message BEFORE streaming
  saveUserMessage(threadId, userMessage);

  const config = loadConfig();
  const agent = await createAgent(config);
  const langgraphConfig = { configurable: { thread_id: threadId } };

  logger.info("Stream started", {
    model: config.model,
    thread_id: threadId,
    request_id: requestId,
  });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1. init chunk
        controller.enqueue(
          makeChunk({
            status: "init",
            msg: { role: "user", content: userMessage, message_type: "text" },
            meta: { thread_id: threadId },
          })
        );

        // 2. Stream graph
        let streamCompleted = false;
        try {
          const eventStream = await agent.stream(
            { messages: [{ role: "user", content: userMessage }] },
            { ...langgraphConfig, streamMode: ["messages" as const] }
          );

          for await (const chunk of eventStream) {
            const [msg] = Array.isArray(chunk) ? chunk : [chunk];
            const type = msg.type ?? msg._getType?.() ?? "";
            if (type === "human" || type === "user") continue;

            const content =
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content
                      .filter((b: any) => b.type === "text")
                      .map((b: any) => b.text)
                      .join("")
                  : "";

            if (!content && type !== "tool") continue;

            controller.enqueue(
              makeChunk({
                status:
                  msg.additional_kwargs?.reasoning_content != null
                    ? "reasoning"
                    : "loading",
                response: content,
                msg: { type, content: msg.content },
                request_id: requestId,
              })
            );
          }
          streamCompleted = true;
        } catch (streamErr: any) {
          // GraphInterrupt is NOT a real error — it's LangGraph's control-flow
          // mechanism. The agent hit interrupt() and saved state. We handle
          // this below via checkAndHandleInterrupts.
          const isInterrupt =
            streamErr?.name === "GraphInterrupt" ||
            streamErr?.message?.includes?.("interrupt") ||
            streamErr?.constructor?.name === "GraphInterrupt";

          if (!isInterrupt) throw streamErr;
          // Interrupt — fall through to check state below
        }

        // 3. Persist AI messages from latest state
        try {
          const state = await agent.getState(langgraphConfig);
          const stateMessages = state?.values?.messages ?? [];
          saveAiMessages(threadId, stateMessages);
        } catch (err) {
          logger.exception("Failed to save AI messages", err);
        }

        // 4. Check for HITL interrupt (matches Python check_and_handle_interrupts)
        const hasInterrupt = await checkAndHandleInterrupts(
          agent, langgraphConfig, threadId, controller
        );

        // 5. Emit finished only if there's no pending interrupt
        if (!hasInterrupt) {
          controller.enqueue(
            makeChunk({ status: "finished", meta: { thread_id: threadId } })
          );
        }
      } catch (err) {
        logger.exception("Agent stream failed", err);
        controller.enqueue(
          makeChunk({
            status: "error",
            error_type: "agent_error",
            error_message: err instanceof Error ? err.message : "未知错误",
            meta: { thread_id: threadId },
          })
        );
      } finally {
        controller.close();
      }
    },
  });

  return c.newResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
});

// =========================================================================
// POST /api/chat/thread/{id}/resume — HITL resume
// Ported from Python `chat_service.py::stream_agent_resume`.
// =========================================================================

chatRouter.post("/thread/:id/resume", getOptionalUser, async (c) => {
  const threadId = c.req.param("id");
  const body = await c.req.json<{ approved: boolean }>();
  const approved = body.approved === true;
  const requestId = getLogContext()?.request_id ?? uuid().slice(0, 8);

  const config = loadConfig();
  const agent = await createAgent(config);
  const langgraphConfig = { configurable: { thread_id: threadId } };

  logger.info("Resume started", { thread_id: threadId, approved, request_id: requestId });

  // Step 1: Read pre-state to count interrupted actions
  // (mirrors Python: graph.aget_state → _extract_interrupt_info → _count_interrupted_actions)
  let actionCount = 1;
  try {
    const preState = await agent.getState(langgraphConfig);
    if (preState) {
      const interruptInfo = extractInterruptInfo(preState);
      if (interruptInfo) {
        actionCount = countInterruptedActions(interruptInfo);
      }
    }
  } catch (err) {
    logger.exception("Failed to read pre-state for resume", err);
    // Fall back to 1
  }

  // Step 2: Normalize resume input — { decisions: [{ type }, ...] }
  const normalizedResume = normalizeResumeInput(approved, actionCount);
  const resumeCommand = new Command({ resume: normalizedResume });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // init chunk (no request_id to avoid double-render in frontend)
        controller.enqueue(
          makeChunk({
            status: "init",
            msg: { type: "system", content: `Resume: ${approved ? "approved" : "rejected"}` },
            meta: { thread_id: threadId },
          })
        );

        // Step 3: Stream the resumed graph
        let streamCompleted = false;
        try {
          const eventStream = await agent.stream(resumeCommand, {
            ...langgraphConfig,
            streamMode: ["messages" as const],
          });

          for await (const chunk of eventStream) {
            const [msg] = Array.isArray(chunk) ? chunk : [chunk];
            const type = msg.type ?? msg._getType?.() ?? "";
            if (type === "human" || type === "user") continue;

            const content =
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content
                      .filter((b: any) => b.type === "text")
                      .map((b: any) => b.text)
                      .join("")
                  : "";

            controller.enqueue(
              makeChunk({
                status:
                  msg.additional_kwargs?.reasoning_content != null
                    ? "reasoning"
                    : "loading",
                response: content,
                msg: { type, content: msg.content },
                request_id: requestId,
              })
            );
          }
          streamCompleted = true;
        } catch (streamErr: any) {
          const isInterrupt =
            streamErr?.name === "GraphInterrupt" ||
            streamErr?.message?.includes?.("interrupt") ||
            streamErr?.constructor?.name === "GraphInterrupt";
          if (!isInterrupt) throw streamErr;
        }

        // Step 4: Persist AI messages
        try {
          const state = await agent.getState(langgraphConfig);
          const stateMessages = state?.values?.messages ?? [];
          saveAiMessages(threadId, stateMessages);
        } catch (err) {
          logger.exception("Failed to save AI messages on resume", err);
        }

        // Step 5: Check for nested interrupts
        const hasInterrupt = await checkAndHandleInterrupts(
          agent, langgraphConfig, threadId, controller
        );

        if (!hasInterrupt) {
          controller.enqueue(
            makeChunk({ status: "finished", meta: { thread_id: threadId } })
          );
        }
      } catch (err) {
        logger.exception("Agent stream failed", err);
        controller.enqueue(
          makeChunk({
            status: "error",
            error_type: "agent_error",
            error_message: err instanceof Error ? err.message : "未知错误",
            meta: { thread_id: threadId },
          })
        );
      } finally {
        controller.close();
      }
    },
  });

  return c.newResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
});
