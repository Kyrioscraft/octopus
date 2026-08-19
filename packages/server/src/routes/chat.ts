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

import { Hono, type Context } from "hono";
import { v4 as uuid } from "uuid";
import { getOptionalUser } from "../auth/middleware.js";
import { makeGraph, loadConfig, getLogger, getLogContext, clearGraphCache } from "@octopus/core";
import { createRipgrepTool, getRipgrepDir } from "@octopus/extension-ripgrep";
import { type ExternalSubagentSpec, type SubagentEntry, resolveAgentPreset, interruptOnForRuleset, GATED_TOOLS } from "@octopus/core";
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
import {
  startRun,
  assignSeq,
  broadcast,
  pauseRun,
  finishRun,
  abortRun,
  getRun,
  attachListener,
  isRunning,
  type RunState,
} from "../services/run-registry.js";
import { createThread, getThread, updateThreadAccessMode, addThreadPermissionRule, getThreadPermissionRules, insertThreadEvent, listThreadEvents, compactThreadEvents } from "../db/index.js";
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

/**
 * Persist an event to the durable thread_events log (opencode durable-event
 * pattern). Persistence failures degrade to memory-only — they must never
 * block or kill the live stream.
 */
function persistThreadEvent(threadId: string, seq: number, chunk: Record<string, unknown>): void {
  try {
    insertThreadEvent(threadId, seq, { ...chunk, seq });
  } catch (err) {
    logger.warn("thread_events persist failed (continuing memory-only)", {
      thread_id: threadId,
      seq,
      error: String(err).slice(0, 120),
    });
  }
}

/**
 * Wrap controller.enqueue with the run registry: every chunk gets a
 * per-thread monotonic `seq` assigned, is persisted to thread_events (durable
 * replay), recorded to the run buffer (live tail), and drives the run's
 * status transitions (terminal event types). An enqueue failure (client
 * disconnected / switched thread) is swallowed — the run belongs to the
 * server and keeps going; only the HTTP side is gone.
 */
/**
 * Subscription-model emit: no HTTP response controller — every chunk goes to
 * the run registry (which persists it durably and fans out to any attached
 * GET /events listeners). This is the only emit shape since POST /agent
 * became fire-and-forget (start the run, return immediately, clients observe
 * via GET /thread/:id/events — opencode's pub/sub model).
 */
function makeRunEmit(run: RunState, controller?: ReadableStreamDefaultController): Emit {
  return (chunk) => {
    // Single write path: assign → PERSIST → broadcast. Persisting before the
    // fan-out makes the durable log a superset of everything any listener can
    // receive, so GET /events closes the replay→live race with a monotonic
    // cursor alone (no identity dedup, no gap fill).
    const seq = assignSeq(run);
    persistThreadEvent(run.threadId, seq, chunk);
    // The wire chunk MUST carry `seq` (same shape as persisted rows) —
    // clients track their high-water cursor from it to subscribe-after on
    // resume; a missing seq froze their cursor and replayed post-ask events.
    const wire = { ...chunk, seq };
    broadcast(run, { seq, chunk: wire });
    const type = (chunk as { type?: string }).type;
    if (type === "ask") pauseRun(run.threadId);
    if (type === "turn.finished" || type === "turn.error" || type === "turn.interrupted") {
      finishRun(run.threadId);
      // Compact the finished turn's delta events asynchronously — the wire
      // event was persisted above, messages were saved by the service.
      setImmediate(() => {
        try {
          compactThreadEvents(run.threadId);
        } catch { /* best-effort */ }
      });
    }
    if (controller) {
      try {
        controller.enqueue(makeChunk({ ...chunk, seq }));
      } catch {
        // Client gone — run continues in the background (opencode semantics:
        // disconnect unsubscribes, it never cancels the run).
      }
    }
  };
}

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
  const threads = listUserThreadsByWorkspace(userId, scope).map((t) => ({
    ...t,
    running: isRunning(t.id),
  }));
  return c.json({ threads });
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
// PATCH /api/chat/thread/{id}/mode  (switch primary agent mid-session)
// =========================================================================
//
// Lets the user switch the primary agent (plan/confirm/auto/full — the
// agent-based successor of the access mode) without sending a new message.
// The chosen agent is persisted on the thread (still the access_mode column
// in phase 1 — identical value domain), so the next resume picks it up —
// this is the "switch takes effect at the next approval point" mechanism.
// The in-flight stream is NOT interrupted.
//
const patchAgentHandler = async (c: Context) => {
  const threadId = c.req.param("id") as string;
  const body = await c.req.json<{ agent?: string }>();
  // Validate against the known set; reject unknown values rather than
  // silently coercing, since an agent switch is an explicit user action.
  const trimmed = body.agent?.trim();
  const agentName =
    trimmed === "plan" || trimmed === "confirm" || trimmed === "auto" || trimmed === "full"
      ? trimmed
      : undefined;
  if (!agentName) {
    return c.json({ detail: "无效的访问模式" }, 400);
  }
  const result = setThreadAccessMode(threadId, agentName);
  if (!result) return c.json({ detail: "会话不存在" }, 404);
  return c.json({ success: true, agent: result.accessMode });
};

chatRouter.patch("/thread/:id/agent", getOptionalUser, patchAgentHandler);

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
  /** Primary agent name from the client: "plan" | "confirm" | "auto" | "full"
   *  (the agent-based successor of the old access mode). plan = read-only
   *  (destructive tools removed); confirm = per-step HITL approval; auto =
   *  fully autonomous (no HITL interrupts); full = auto + FileEditGuard off. */
  agent?: string;
  /** Legacy access-mode field — folded into `agent` below (older clients). */
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
  // Bundled ripgrep binary directory (null when the binary is missing) —
  // prepended to the shell backend's PATH so bare `rg` works in execute.
  const rgDir = getRipgrepDir();
  // Resolve the primary agent early so we can persist it on thread creation.
  // New clients send `agent`; legacy clients send `mode` with the same four
  // values (every legacy mode IS a builtin agent in phase 1). Anything missing
  // or unrecognized falls back to "confirm" (the per-step-approval default).
  const rawAgent = body.agent?.trim();
  // Message-level agent binding (phase 3): when the client doesn't specify,
  // inherit the thread's last user-message agent (opencode prompt.ts:437
  // semantics) so consecutive turns keep the same agent. Falls back to the
  // thread's persisted agent, then "confirm".
  const inheritedAgent = (() => {
    const lastUser = [...(existing?.messages ?? [])].reverse().find((m) => m.role === "user");
    const fromMsg = lastUser?.extraMetadata?.agent;
    if (typeof fromMsg === "string" && fromMsg) return fromMsg;
    return existing?.accessMode ?? "confirm";
  })();
  const requestedAgent = rawAgent || inheritedAgent;
  const agentName =
    requestedAgent === "plan" || requestedAgent === "auto" || requestedAgent === "full" || requestedAgent === "confirm"
      ? requestedAgent
      : "confirm";
  // The DB column is still named access_mode (legacy naming, kept for data
  // compat) — agent names are stored verbatim, no migration needed.
  const accessMode = agentName;
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

  // Persist user message BEFORE streaming — carrying the resolved agent so
  // the next turn can inherit it (message-level agent binding, phase 3).
  saveUserMessage(threadId, userMessage, agentName);

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
    agent: agentName,
    request_id: requestId,
    user_msg_preview: userMessage.slice(0, 50),
  });

  let agent: any;
  let subagentRegistry: Map<string, any>;
  try {
    const compiled = await makeGraph(config, {
      cwd: agentCwd,
      workspace: { environment: workspace.environment },
      // The agent preset drives toolset filtering at build time (plan strips
      // destructive tools, full bypasses FileEditGuard). It is part of the
      // graph cache key, so each agent compiles its own graph.
      agent: agentName,
      // Inject the user's file-source + user-defined subagents (merged). core
      // adds built-ins (Explore, general-purpose) itself. Part of cache key.
      userSubagents: resolveUserSubagents(userId),
      // Built-in subagent model overrides (name → model, null = default).
      // Part of the cache key, so changing a built-in's model recompiles.
      builtinSubagentOverrides: resolveBuiltinOverrides(userId),
      // Inject the ripgrep extension tool (grep_search) — high-priority search
      // that returns matches with line numbers and context in one call.
      externalTools: [createRipgrepTool(agentCwd)],
      // Prepend the bundled ripgrep dir to the shell PATH so bare `rg` in
      // execute commands works without a host ripgrep install.
      extraPathDirs: rgDir ? [rgDir] : undefined,
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
  // The preset override is MERGED with the thread's accumulated "always"
  // rules (later wins) so session-level approvals persist across turns.
  const interruptOverride = (() => {
    const base = interruptOnForRuleset(resolveAgentPreset(agentName).permission, GATED_TOOLS) ?? {};
    const alwaysOverride =
      interruptOnForRuleset(getThreadPermissionRules(threadId), GATED_TOOLS) ?? {};
    const merged = { ...base, ...alwaysOverride };
    return Object.keys(merged).length > 0 ? merged : null;
  })();
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

  // Subscription model (opencode semantics): POST /agent only STARTS the run
  // and returns immediately. Every chunk goes to the run registry (durable
  // persistence + fan-out), and clients observe via GET /thread/:id/events —
  // which replays from seq 0 then tails live, so nothing between the POST
  // returning and the client subscribing is lost. Multiple clients (web +
  // TUI) can subscribe to the same thread independently.
  const run = startRun(threadId);
  const emit = makeRunEmit(run);
  void (async () => {
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
          startedAt: run.startedAt,
        },
        emit,
        run.abort.signal,
      );
    } catch (err) {
      logger.exception("Background run failed", err);
      emit({ type: "turn.error", errorType: "internal", message: (err as Error).message || "未知错误", threadId });
    } finally {
      // A paused (HITL) exit must keep its registry entry.
      if (getRun(threadId)?.status === "running") finishRun(threadId);
    }
  })();

  return c.json({ threadId, requestId }, 202);
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
  // Bundled ripgrep binary directory (null when the binary is missing) —
  // prepended to the shell backend's PATH so bare `rg` works in execute.
  const rgDir = getRipgrepDir();
  // Read the persisted agent (access_mode column) so resume honors the
  // user's LATEST choice, not the agent active when the turn started. This is
  // what makes a mid-run switch take effect at the next approval point: the
  // user can switch to auto/full, and subsequent resumes suppress HITL
  // accordingly. Legacy rows (no access_mode) coerce to "confirm".
  let agentName = (() => {
    const m = existingThread?.accessMode;
    return m === "plan" || m === "auto" || m === "full" ? m : "confirm";
  })();
  // Plan approval gate: when the user approves a submitted plan, flip the
  // thread to the confirm agent BEFORE resuming — the resumed turn then runs
  // with the full (write-capable) toolset under per-tool HITL, mirroring
  // opencode's plan_exit → build handoff. A synthetic user message records
  // the handoff (message-level agent binding, phase 3). Rejection keeps plan
  // so the agent revises.
  if (resumeBody.kind === "plan_approval" && agentName === "plan" && resumeBody.approved !== false) {
    updateThreadAccessMode(threadId, "confirm");
    agentName = "confirm";
    saveUserMessage(
      threadId,
      "计划已批准，开始执行（已切换到 confirm 智能体）",
      "confirm",
    );
  }
  const compiled = await makeGraph(config, {
    cwd: agentCwd,
    workspace: { environment: workspace.environment },
    // The agent preset rebuilds the graph for the right toolset (plan strips
    // destructive tools, full bypasses FileEditGuard) and is part of the cache
    // key, so each agent resolves to its own compiled graph.
    agent: agentName,
    // Inject the same user subagents as the original turn so delegation works
    // consistently on resume.
    userSubagents: resolveUserSubagents(userId),
    builtinSubagentOverrides: resolveBuiltinOverrides(userId),
    // Inject the same ripgrep extension tool as the original turn.
    externalTools: [createRipgrepTool(agentCwd)],
    // Same bundled ripgrep PATH dir as the original turn.
    extraPathDirs: rgDir ? [rgDir] : undefined,
  });
  const agent = compiled.agent;
  const subagentRegistry = compiled.subagentRegistry;
  // Re-inject the HITL override for the resolved agent, mirroring the /agent
  // path. Without this, resume would fall back to the compiled default
  // (confirm) and re-trigger approvals even in auto/full mode — the original
  // cause of "auto mode still asks for approval after a question interrupt".
  // The preset's override is MERGED with the thread's accumulated "always"
  // rules (later wins) so session-level approvals carry across turns.
  const interruptOverride = (() => {
    const base = interruptOnForRuleset(resolveAgentPreset(agentName).permission, GATED_TOOLS) ?? {};
    const threadRules = getThreadPermissionRules(threadId);
    const alwaysOverride = interruptOnForRuleset(threadRules, GATED_TOOLS) ?? {};
    const merged = { ...base, ...alwaysOverride };
    return Object.keys(merged).length > 0 ? merged : null;
  })();

  // Persist "always" decisions server-side (successor of the client-side
  // sessionAllowlist): each always-approved tool becomes a thread-level
  // allow rule, effective from this resume onward. The client includes the
  // tool name on each decision (context.source of the ask payload); unknown
  // names are skipped. The decision itself is folded to "approve" below —
  // langchain's HITL middleware only knows approve/reject/edit.
  if (resumeBody.kind === "tool_approval" && Array.isArray(resumeBody.decisions)) {
    const decisions = resumeBody.decisions;
    for (let i = 0; i < decisions.length; i++) {
      const d = decisions[i] as Record<string, unknown>;
      if (d?.type === "always" && typeof d.tool === "string") {
        addThreadPermissionRule(threadId, {
          permission: d.tool,
          pattern: "*",
          action: "allow",
        });
      }
    }
    // Fold always → approve for the langchain resume value.
    resumeBody.decisions = decisions.map((d) =>
      (d as { type?: string })?.type === "always" ? { type: "approve" as const } : d,
    );
  }
  const langgraphConfig = {
    configurable: { thread_id: threadId },
    ...(interruptOverride ? { context: { interruptOn: interruptOverride } } : {}),
  };

  logger.info("Resume started", {
    thread_id: threadId,
    kind: resumeBody.kind,
    agent: agentName,
    request_id: requestId,
  });

  // Subscription model: resume also only starts the run; clients observe via
  // GET /thread/:id/events (replay + live tail).
  const run = startRun(threadId);
  const emit = makeRunEmit(run);
  void (async () => {
    try {
      await streamResume(
        {
          threadId,
          requestId,
          resumeBody,
          agent,
          subagentRegistry,
          langgraphConfig,
          startedAt: run.startedAt,
        },
        emit,
        run.abort.signal,
      );
    } catch (err) {
      logger.exception("Background resume failed", err);
      emit({ type: "turn.error", errorType: "internal", message: (err as Error).message || "未知错误", threadId });
    } finally {
      // Only finish a run that is still RUNNING. A turn that ended at a HITL
      // interrupt is `paused` (set by makeRunEmit on the ask chunk) — the
      // registry entry must SURVIVE so /threads reports running and a
      // re-attaching client can restore the ask panel from the replay
      // buffer. finishRun would erase it and the thread would look done.
      if (getRun(threadId)?.status === "running") finishRun(threadId);
    }
  })();

  return c.json({ threadId, requestId }, 202);
});

// =========================================================================
// GET /api/chat/thread/{id}/events?after=<seq>  (re-attach to a running turn)
// =========================================================================
//
// Re-attachment protocol (opencode's replay-then-live pattern): the client
// opens this stream when entering a thread whose run may still be active.
// Events with seq > after are replayed from the DURABLE thread_events table
// first (survives restarts and late re-attach), then live events tail from the
// in-memory run registry. A 10s heartbeat keeps intermediaries from killing
// the idle connection. When no run is active and the durable log's last event
// is terminal (or empty), a synthetic `idle` tells the client to fall back to
// /history.

chatRouter.get("/thread/:id/events", getOptionalUser, (c) => {
  const threadId = c.req.param("id");
  const after = Number(c.req.query("after") ?? "0") || 0;
  const run = getRun(threadId);

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const push = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(makeChunk(payload));
        } catch {
          closed = true;
        }
      };

      const runActive = run !== undefined && (run.status === "running" || run.status === "paused");

      // ---- No live run: pure durable replay, then close ------------------
      if (!runActive) {
        let maxSeq = after;
        let lastType: string | undefined;
        try {
          for (const e of listThreadEvents(threadId, after)) {
            push(e.event);
            maxSeq = Math.max(maxSeq, e.seq);
            const t = e.event["type"];
            if (typeof t === "string") lastType = t;
          }
        } catch (err) {
          logger.exception("Durable event replay failed", err);
        }
        // If the durable log ends at a non-terminal state (crash / restart
        // mid-turn), tell the client the turn was lost so it can mark the
        // bubble errored instead of hanging.
        if (lastType && lastType !== "turn.finished" && lastType !== "turn.error" &&
            lastType !== "turn.interrupted" && lastType !== "idle") {
          push({ type: "turn.error", errorType: "run_lost", message: "服务重启导致本轮执行中断", threadId, seq: maxSeq + 1 });
        }
        push({ type: "idle", threadId, seq: maxSeq + 2 });
        try { controller.close(); } catch { /* */ }
        return;
      }

      // ---- Live tail: subscribe FIRST, then snapshot, cursor filter --------
      // Single-write-path handoff (see makeRunEmit): events are persisted
      // BEFORE broadcast, so anything the listener delivers between attach and
      // the snapshot read is already in the snapshot. A monotonic cursor over
      // seq — advance past everything pushed — drops that overlap exactly
      // once; no identity set, no gap fill.
      const pending = new Map<number, Record<string, unknown>>();
      const detach = attachListener(threadId, (e) => {
        if (e.seq > cursor) pending.set(e.seq, e.chunk);
      }) ?? (() => {});

      // Snapshot AFTER the listener is registered.
      let cursor = after - 1; // push only events with seq > cursor
      let lastTypeLive: string | undefined;
      try {
        for (const e of listThreadEvents(threadId, after)) {
          push(e.event);
          cursor = Math.max(cursor, e.seq);
          const t = e.event["type"];

        }
      } catch (err) {
        logger.exception("Durable event replay failed", err);
      }

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const finalize = () => {
        detach();
        if (heartbeat) clearInterval(heartbeat);
        // Drain anything still pending (post-ask trailing events) before the
        // idle terminator — dropping them would truncate the turn AND desync
        // the client's cursor (those seqs would replay on the next subscribe).
        for (const [seq, chunk] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
          pending.delete(seq);
          if (seq <= cursor) continue;
          cursor = seq;
          push(chunk);
        }
        push({ type: "idle", threadId });
        try { controller.close(); } catch { /* */ }
      };

      if (run!.status !== "running") {
        // paused (HITL) — the replayed log already contains the `ask`; close.
        for (const [seq, chunk] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
          if (seq > cursor) push(chunk);
        }
        finalize();
        return;
      }

      heartbeat = setInterval(() => push({ type: "heartbeat" }), 10_000);
      const flush = setInterval(() => {
        const entries = [...pending.entries()].sort((a, b) => a[0] - b[0]);
        for (const [seq, chunk] of entries) {
          pending.delete(seq);
          if (seq <= cursor) continue; // already covered by the snapshot
          cursor = seq;
          push(chunk);
          const t = (chunk as { type?: string }).type;
          if (t === "turn.finished" || t === "turn.error" || t === "turn.interrupted") {
            finalize();
            return;
          }
        }
        if (getRun(threadId)?.status !== "running") {
          finalize();
        }
      }, 100);
    },
  });

  return c.newResponse(stream, { headers: NDJSON_HEADERS });
});

// =========================================================================
// POST /api/chat/thread/{id}/stop  (explicit stop of a background run)
// =========================================================================
//
// The successor of "abort the fetch to stop the run": with runs decoupled from
// connections, stopping must be explicit. Aborts the run's AbortController —
// the streamChat/streamResume loop sees the abort, saves partial output, and
// emits `interrupted` to any attached listeners.

chatRouter.post("/thread/:id/stop", getOptionalUser, (c) => {
  const threadId = c.req.param("id");
  const stopped = abortRun(threadId);
  return c.json({ success: true, stopped });
});
