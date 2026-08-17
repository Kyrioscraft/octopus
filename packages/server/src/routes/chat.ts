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
import { makeGraph, loadConfig, getLogger, getLogContext, clearGraphCache } from "@octopus/core";
import { createRipgrepTool } from "@octopus/extension-ripgrep";
import { type AccessMode, type ExternalSubagentSpec, type SubagentEntry, interruptOnForMode } from "@octopus/core";
import {
  listUserThreads,
  listUserThreadsByWorkspace,
  getThreadHistory,
  renameThread,
  setThreadAccessMode,
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
import { listAllSubagents, resolveBuiltinOverrides } from "../services/subagent.service.js";

export const chatRouter = new Hono();

/**
 * Resolve the user's subagents (file-source + user-defined, merged) into the
 * shape core's makeGraph expects. Filters to enabled entries only. Built-in
 * subagents (Explore, general-purpose) are added by core itself, so they are
 * excluded here to avoid duplication.
 */
function resolveUserSubagents(userId: string): ExternalSubagentSpec[] {
  try {
    const all = listAllSubagents(userId);
    return all
      .filter((s) => s.enabled && s.origin !== "builtin")
      .map((s: SubagentEntry) => ({
        name: s.name,
        description: s.description,
        systemPrompt: s.systemPrompt,
        tools: s.tools,
        model: s.model ?? null,
        enabled: s.enabled,
        source: s.origin === "user-defined" ? ("user-defined" as const) : ("file" as const),
      }));
  } catch (err) {
    // Subagent resolution must never block the chat — log and proceed with none.
    const log = getLogger("chat.route");
    log.exception("Failed to resolve user subagents; proceeding without them", err as Error);
    return [];
  }
}

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
// PATCH /api/chat/thread/{id}/mode  (switch access mode mid-session)
// =========================================================================
//
// Lets the user switch the access mode (plan/confirm/auto/full) without
// sending a new message. The chosen mode is persisted on the thread, so the
// next resume picks it up — this is the "switch takes effect at the next
// approval point" mechanism. The in-flight stream is NOT interrupted.

chatRouter.patch("/thread/:id/mode", getOptionalUser, async (c) => {
  const threadId = c.req.param("id");
  const { mode } = await c.req.json<{ mode: string }>();
  // Validate against the known set; reject unknown values rather than
  // silently coercing, since a mode switch is an explicit user action.
  const trimmed = mode?.trim();
  if (trimmed !== "plan" && trimmed !== "confirm" && trimmed !== "auto" && trimmed !== "full") {
    return c.json({ detail: "无效的访问模式" }, 400);
  }
  const result = setThreadAccessMode(threadId, trimmed);
  if (!result) return c.json({ detail: "会话不存在" }, 404);
  return c.json({ success: true, mode: result.accessMode });
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
  /** Workspace access mode from the client: "plan" | "confirm" | "auto".
   *  plan = read-only (destructive tools removed); confirm = per-step HITL
   *  approval; auto = fully autonomous (no HITL interrupts). */
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
  // Resolve the access mode early so we can persist it on thread creation.
  // The client sends "plan" | "confirm" | "auto" | "full"; anything missing or
  // unrecognized falls back to "confirm" (the per-step-approval default).
  const rawModeForCreate = body.mode?.trim();
  const accessMode: AccessMode =
    rawModeForCreate === "plan" || rawModeForCreate === "auto" || rawModeForCreate === "full"
      ? rawModeForCreate
      : "confirm";
  if (!threadId) {
    threadId = `thread_${uuid()}`;
    createThread({
      id: threadId,
      userId,
      agentId: body.agent_id,
      workspaceId: workspace.id,
      accessMode,
    });
  } else if (!existing) {
    createThread({
      id: threadId,
      userId,
      agentId: body.agent_id,
      workspaceId: workspace.id,
      accessMode,
    });
  } else {
    // Existing thread: keep its persisted mode in sync with the request so a
    // mode switch is reflected for the next resume even if the user didn't
    // hit the dedicated mode endpoint.
    if (existing.accessMode !== accessMode) {
      setThreadAccessMode(threadId, accessMode);
    }
  }
  // Make sure this conversation has an outputs/ directory inside the workspace.
  ensureThreadOutputs(userId, workspace.id, threadId);

  // Persist user message BEFORE streaming
  saveUserMessage(threadId, userMessage);

  const config = loadConfig();
  const modelOverride = body.model?.trim() || undefined;
  // When the user picks a non-default model in the chat input, clear the graph
  // cache so makeGraph rebuilds with fresh config.json values (latest
  // baseURL/apiKey). Graphs compiled for the default model are reused as-is.
  if (modelOverride) {
    clearGraphCache();
  }
  // `accessMode` was resolved above (before thread creation) so it could be
  // persisted on the thread row. It drives both graph build (plan strips
  // destructive tools, full bypasses FileEditGuard) and the runtime HITL
  // override (auto/full suppress all gated tools).
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
      // accessMode drives toolset filtering at build time (plan strips
      // destructive tools). It is part of the graph cache key, so each mode
      // compiles its own graph.
      accessMode,
      // Inject the user's file-source + user-defined subagents (merged). core
      // adds built-ins (Explore, general-purpose) itself. Part of cache key.
      userSubagents: resolveUserSubagents(userId),
      // Built-in subagent model overrides (name → model, null = default).
      // Part of the cache key, so changing a built-in's model recompiles.
      builtinSubagentOverrides: resolveBuiltinOverrides(userId),
      // Inject the ripgrep extension tool (grep_search) — high-priority search
      // that returns matches with line numbers and context in one call.
      externalTools: [createRipgrepTool(agentCwd)],
    });
    agent = compiled.agent;
    subagentRegistry = compiled.subagentRegistry;
  } catch (err) {
    logger.exception("Failed to create agent graph", err);
    return c.json({ detail: (err as Error).message || "模型加载失败" }, 500);
  }
  // `model` in configurable is read by the configurable_model middleware to
  // rebuild the chat model for this run. Omitted → uses config default.
  //
  // `accessMode` controls HITL at runtime: `auto` injects an `interruptOn`
  // override into the langchain agent's runtime context, which
  // humanInTheLoopMiddleware merges over its compiled config (see hitl.js) so
  // every gated tool auto-approves. `plan`/`confirm` need no override here —
  // plan has no destructive tools to gate, confirm keeps the compiled default.
  const interruptOverride = interruptOnForMode(accessMode);
  // `configurable` carries the LangGraph checkpointer key (thread_id).
  // `context` carries per-invocation values surfaced to middleware via
  // `runtime.context` (filtered through each middleware's contextSchema).
  // The runtime model override lives on `context.model` so
  // ConfigurableModelMiddleware can read it — putting it on `configurable`
  // would NOT reach `runtime.context`.
  const langgraphConfig = {
    configurable: {
      thread_id: threadId,
    },
    context: {
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(interruptOverride ? { interruptOn: interruptOverride } : {}),
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
  // Read the persisted access mode so resume honors the user's LATEST choice,
  // not the mode that was active when the turn started. This is what makes a
  // mid-run mode switch take effect at the next approval point: the user can
  // switch to auto/full, and subsequent resumes suppress HITL accordingly.
  // Legacy rows (no access_mode) coerce to "confirm" in the db mapper.
  const accessMode: AccessMode = (() => {
    const m = existingThread?.accessMode;
    return m === "plan" || m === "auto" || m === "full" ? m : "confirm";
  })();
  const compiled = await makeGraph(config, {
    cwd: agentCwd,
    workspace: { environment: workspace.environment },
    // accessMode rebuilds the graph for the right toolset (plan strips
    // destructive tools, full bypasses FileEditGuard) and is part of the cache
    // key, so each mode resolves to its own compiled graph.
    accessMode,
    // Inject the same user subagents as the original turn so delegation works
    // consistently on resume.
    userSubagents: resolveUserSubagents(userId),
    builtinSubagentOverrides: resolveBuiltinOverrides(userId),
    // Inject the same ripgrep extension tool as the original turn.
    externalTools: [createRipgrepTool(agentCwd)],
  });
  const agent = compiled.agent;
  const subagentRegistry = compiled.subagentRegistry;
  // Re-inject the HITL override for the resolved mode, mirroring the /agent
  // path. Without this, resume would fall back to the compiled default
  // (confirm) and re-trigger approvals even in auto/full mode — the original
  // cause of "auto mode still asks for approval after a question interrupt".
  const interruptOverride = interruptOnForMode(accessMode);
  const langgraphConfig = {
    configurable: { thread_id: threadId },
    ...(interruptOverride ? { context: { interruptOn: interruptOverride } } : {}),
  };

  logger.info("Resume started", {
    thread_id: threadId,
    kind: resumeBody.kind,
    mode: accessMode,
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
