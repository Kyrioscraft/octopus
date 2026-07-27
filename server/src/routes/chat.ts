/**
 * Chat route — thin HTTP adapter.
 *
 * Responsibilities (only): parse/validate request, build the agent graph,
 * create the NDJSON ReadableStream, delegate streaming to chat.service.
 * All business logic (persistence, HITL, title generation, chunk translation)
 * lives in services/chat.service.ts + services/thread.service.ts.
 *
 * Equivalent to Python `chat_service.py` HTTP-facing portion.
 */

import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getOptionalUser } from "../auth/middleware.js";
import { makeGraph, loadConfig, getLogger, getLogContext } from "@octopus/core";
import {
  listUserThreads,
  listUserThreadsByWorkspace,
  getThreadHistory,
  renameThread,
  deleteThreadById,
  createUserThread,
} from "../services/thread.service.js";
import {
  saveUserMessage,
  streamChat,
  streamResume,
  type Emit,
  type ResumeRequestBody,
} from "../services/chat.service.js";
import { createThread, getThread } from "../db/index.js";
import {
  ensureThreadOutputs,
  resolveAgentCwd,
} from "../services/workspace.service.js";

export const chatRouter = new Hono();

const logger = getLogger("chat.router");

const encoder = new TextEncoder();
const makeChunk = (payload: Record<string, unknown>): Uint8Array =>
  encoder.encode(JSON.stringify(payload) + "\n");

/** NDJSON stream headers shared by the two streaming endpoints. */
const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Transfer-Encoding": "chunked",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

// =========================================================================
// GET /api/chat/threads
// =========================================================================

chatRouter.get("/threads", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  // Optional workspace scoping: ?workspace_id=<id> lists only that workspace's
  // threads; ?workspace_id=unbound lists threads with no workspace.
  const wsId = c.req.query("workspace_id");
  const scope = wsId === "unbound" ? null : wsId || undefined;
  return c.json({ threads: listUserThreadsByWorkspace(userId, scope) });
});

// =========================================================================
// GET /api/chat/thread/{id}/history
// =========================================================================

chatRouter.get("/thread/:id/history", getOptionalUser, (c) => {
  const history = getThreadHistory(c.req.param("id"));
  if (history === null) return c.json({ detail: "会话不存在" }, 404);
  return c.json({ history });
});

// =========================================================================
// DELETE /api/chat/thread/{id}
// =========================================================================

chatRouter.delete("/thread/:id", getOptionalUser, (c) => {
  deleteThreadById(c.req.param("id"));
  return c.json({ success: true });
});

// =========================================================================
// PUT /api/chat/thread/{id}  (rename)
// =========================================================================

chatRouter.put("/thread/:id", getOptionalUser, async (c) => {
  const { title } = await c.req.json<{ title: string }>();
  const result = renameThread(c.req.param("id"), title);
  if (!result) return c.json({ detail: "会话不存在" }, 404);
  return c.json({ success: true, title: result.title });
});

// =========================================================================
// POST /api/chat/agent  (stream a fresh chat turn)
// =========================================================================

interface ChatRequest {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  thread_id?: string;
  agent_id?: string;
  /** Workspace to bind this thread to (its dir becomes the agent's cwd). */
  workspace_id?: string;
  /** Optional per-request model override ("provider:model"). Applied via the
   *  configurable_model middleware at runtime; falls back to config default. */
  model?: string;
  /** Workspace access mode hint from the client: "plan" | "confirm" | "auto".
   *  Logged only this iteration — does not yet alter graph behavior. */
  mode?: string;
}

chatRouter.post("/agent", getOptionalUser, async (c) => {
  const body = await c.req.json<ChatRequest>();
  const userId = c.var.user.sub;
  const userMessage = body.messages?.at(-1)?.content ?? "";
  const requestId = getLogContext()?.request_id ?? uuid().slice(0, 8);
  let threadId = body.thread_id;
  // A thread counts as "new" (eligible for auto-title generation) when it
  // either doesn't exist yet or has no prior messages — captured BEFORE
  // creating/persisting so the check isn't fooled by the user message we're
  // about to save.
  const existing = threadId ? getThread(threadId) : undefined;
  const isNewThread = !existing || existing.messages.length === 0;
  // Resolve the workspace: prefer the request's workspace_id, else reuse the
  // thread's existing binding, else fall back to the user's default workspace.
  // resolveAgentCwd also yields the dir the agent should treat as cwd.
  const requestedWsId =
    body.workspace_id ?? existing?.workspaceId ?? undefined;
  const { cwd: agentCwd, workspace } = resolveAgentCwd(userId, requestedWsId ?? null);
  if (!threadId) {
    threadId = `thread_${uuid()}`;
    createThread({
      id: threadId,
      userId,
      agentId: body.agent_id,
      workspaceId: workspace.id,
    });
  } else if (!existing) {
    createThread({
      id: threadId,
      userId,
      agentId: body.agent_id,
      workspaceId: workspace.id,
    });
  }
  // Make sure this conversation has an outputs/ directory inside the workspace.
  ensureThreadOutputs(userId, workspace.id, threadId);

  // Persist user message BEFORE streaming
  saveUserMessage(threadId, userMessage);

  const config = loadConfig();
  const modelOverride = body.model?.trim() || undefined;
  const accessMode = body.mode?.trim() || undefined;
  logger.info("Chat request — resolved config", {
    model: modelOverride ?? config.model,
    thread_id: threadId,
    workspace_id: workspace.id,
    cwd: agentCwd,
    mode: accessMode,
    request_id: requestId,
    user_msg_preview: userMessage.slice(0, 50),
  });

  let agent: any;
  let subagentRegistry: Map<string, any>;
  try {
    const compiled = await makeGraph(config, {
      cwd: agentCwd,
      workspace: { environment: workspace.environment },
    });
    agent = compiled.agent;
    subagentRegistry = compiled.subagentRegistry;
  } catch (err) {
    logger.exception("Failed to create agent graph", err);
    return c.json({ detail: (err as Error).message || "模型加载失败" }, 500);
  }
  // `model` in configurable is read by the configurable_model middleware to
  // rebuild the chat model for this run. Omitted → uses config default.
  const langgraphConfig = {
    configurable: {
      thread_id: threadId,
      ...(modelOverride ? { model: modelOverride } : {}),
    },
  };

  logger.info("Stream started", {
    model: modelOverride ?? config.model,
    thread_id: threadId,
    request_id: requestId,
  });

  const stream = new ReadableStream({
    async start(controller) {
      // The emit callback wraps controller.enqueue in NDJSON encoding. Service
      // calls emit() with a plain chunk object — transport stays in the route.
      const emit: Emit = (chunk) => controller.enqueue(makeChunk(chunk));
      try {
        await streamChat(
          {
            threadId,
            userMessage,
            requestId,
            isNewThread,
            agent,
            subagentRegistry,
            langgraphConfig,
            modelSpec: config.model,
          },
          emit,
        );
      } finally {
        controller.close();
      }
    },
  });

  return c.newResponse(stream, { headers: NDJSON_HEADERS });
});

// =========================================================================
// POST /api/chat/thread/{id}/resume  (HITL resume)
// =========================================================================

chatRouter.post("/thread/:id/resume", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const threadId = c.req.param("id");
  // Accept the unified ResumeRequestBody. Legacy clients send only
  // `{ approved: boolean }` — fold it into kind: "tool_approval" so the
  // service's normalizeResumeInput handles it uniformly.
  const parsed = await c.req.json<Partial<ResumeRequestBody>>();
  const resumeBody: ResumeRequestBody = {
    ...parsed,
    kind: parsed.kind ?? "tool_approval",
  };
  const requestId = getLogContext()?.request_id ?? uuid().slice(0, 8);

  const config = loadConfig();
  // Resume in the same workspace the thread was bound to at creation.
  const existingThread = getThread(threadId);
  const { cwd: agentCwd, workspace } = resolveAgentCwd(userId, existingThread?.workspaceId ?? null);
  const compiled = await makeGraph(config, {
    cwd: agentCwd,
    workspace: { environment: workspace.environment },
  });
  const agent = compiled.agent;
  const subagentRegistry = compiled.subagentRegistry;
  const langgraphConfig = { configurable: { thread_id: threadId } };

  logger.info("Resume started", {
    thread_id: threadId,
    kind: resumeBody.kind,
    request_id: requestId,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (chunk) => controller.enqueue(makeChunk(chunk));
      try {
        await streamResume(
          {
            threadId,
            requestId,
            resumeBody,
            agent,
            subagentRegistry,
            langgraphConfig,
          },
          emit,
        );
      } finally {
        controller.close();
      }
    },
  });

  return c.newResponse(stream, { headers: NDJSON_HEADERS });
});
