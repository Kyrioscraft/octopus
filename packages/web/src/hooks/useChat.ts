import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { message as antdMessage } from "antd";
import {
  OctopusClient,
  type StreamEvent,
  type ModelProviderEntry,
  type AskUserQuestionPayload,
  type ResumeRequestBody,
  type SlashCommandEntry,
} from "@octopus/tentacle";
import { TurnEventAccumulator, contentFromEvents } from "../components/chat/turn/TurnEventAccumulator.js";
import type { TurnEvent, SubagentEvent } from "../components/chat/turn/types.js";
import type { ToolCallEntry } from "../components/chat/rows/tools/types.js";
import type { TodoItem } from "../components/chat/companion/types.js";
import type { Msg } from "../components/chat/types.js";
import type { AccessMode } from "../components/chat/constants.js";
import { MODE_ORDER } from "../components/chat/constants.js";
import { useThemeStore } from "../stores/theme.js";
import { useChatStore } from "../stores/chat.js";

const sdk = new OctopusClient();

/**
 * Two-pass normalization of persisted thread history into the Msg[] view model.
 *
 * Tool messages (role:"tool") are stored as independent rows carrying
 * extraMetadata.tool_call_id. We pair them back into the originating assistant
 * message's tool call result and drop the standalone tool rows so they don't
 * render as bubbles. Then an ordered events[] timeline is reconstructed
 * (reasoning → tool calls → text reply). Historical data lost the precise
 * interleaving order; live turns preserve true order via TurnEventAccumulator.
 */
function normalizeHistory(rows: any[]): Msg[] {
  const toolResults = new Map<string, string>();
  for (const m of rows) {
    if (m.role === "tool") {
      const tcId = (m.extraMetadata as Record<string, unknown> | undefined)?.tool_call_id as
        | string
        | undefined;
      if (tcId) toolResults.set(tcId, m.content);
    }
  }
  // An interrupted partial (error_type:"interrupted") saves the ACCUMULATED
  // turn text — which includes raw tool stdout, because live accumulation
  // can't distinguish tool output from reply text. Rendered as a plain text
  // event it shows up as a wall of tool output. Instead, fold such content
  // into the PREVIOUS assistant message's last result-less tool row (the
  // in-flight tool whose output was captured), and keep only a trailing
  // non-tool remainder (if any) as the text event.
  const interruptedPartials = new Set<any>();
  for (const m of rows) {
    const em = m.extraMetadata as Record<string, unknown> | undefined;
    if (m.role === "assistant" && em?.error_type === "interrupted") {
      interruptedPartials.add(m);
    }
  }
  const msgs: Msg[] = [];
  for (const m of rows) {
    if (m.role === "tool") continue;
    if (interruptedPartials.has(m)) {
      // Case A: the previous assistant msg's last event is a tool row — the
      // turn was interrupted at/after that tool call, and the accumulated
      // "text" is actually the tool's stdout (live accumulation can't tell
      // them apart). Fold it into that tool row (keep an already-persisted
      // result if present).
      const prevAssistant = [...msgs].reverse().find((x) => x.role === "assistant" && x.events?.length);
      const lastEvent = prevAssistant?.events?.[prevAssistant.events.length - 1];
      if (lastEvent?.type === "tool") {
        lastEvent.entry = {
          ...lastEvent.entry,
          status: "done",
          result: lastEvent.entry.result
            ? lastEvent.entry.result
            : m.content,
        };
        continue; // folded — no separate bubble
      }
      // Case B: no assistant row since the last user message — the partial is
      // this turn's ONLY output and is tool stdout with no surviving tool row
      // (the AI/tool messages were never persisted). Render as an interrupted
      // assistant bubble: error status so it reads as "stopped", not a reply.
      const lastMsg = msgs[msgs.length - 1];
      if (!lastMsg || lastMsg.role === "user") {
        msgs.push({
          id: m.id,
          role: "assistant",
          content: m.content,
          status: "error",
          error: "对话已中断（部分输出）",
        } as Msg);
        continue;
      }
      // Case C: previous assistant ended with reasoning/text — genuine
      // partial reply text; fall through and render normally.
    }
    const extra = m.extraMetadata as Record<string, unknown> | undefined;
    const addKw = extra?.additional_kwargs as Record<string, unknown> | undefined;
    const reasoning = (addKw?.reasoning_content as string | undefined) ?? "";
    const rawToolCalls =
      (m.toolCalls as Array<Record<string, unknown>> | undefined) ?? undefined;
    const toolCalls: ToolCallEntry[] | undefined = rawToolCalls
      ? rawToolCalls.map((tc) => {
          const id = (tc.id as string) ?? `tc_${Date.now()}_${Math.random()}`;
          const result = toolResults.get(id);
          return {
            id,
            name: (tc.name as string) ?? "unknown",
            args: (tc.args as Record<string, unknown>) ?? {},
            status: "done" as const,
            ...(result ? { result } : {}),
          };
        })
      : undefined;
    const events: TurnEvent[] = [];
    let seq = 0;
    if (reasoning) {
      events.push({ id: `${m.id}_rs_${seq++}`, type: "reasoning", text: reasoning, startedAt: 0 });
    }
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (tc.name === "task") {
          const args = tc.args as { subagent_type?: string; description?: string };
          events.push({
            id: `${m.id}_sa_${seq++}`,
            type: "subagent",
            agentNs: args.subagent_type ?? "general-purpose",
            description: args.description ?? "",
            events: [],
            status: "done",
            ...(tc.result ? { result: tc.result } : {}),
          });
        } else {
          events.push({ id: `${m.id}_te_${seq++}`, type: "tool", entry: tc });
        }
      }
    }
    if (m.content) {
      events.push({ id: `${m.id}_tx_${seq++}`, type: "text", text: m.content });
    }
    if (m.role === "assistant") {
      // One persisted TURN spans MULTIPLE assistant rows (each AI message with
      // tool_calls is stored separately by saveAiMessages). Live rendering
      // shows one bubble per turn — mirror that: append this row's events to
      // the current turn bubble instead of creating a new one. This also puts
      // the persisted work_duration_ms (stamped on the turn's LAST row) on
      // the turn's single WorkTimer.
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg.status !== "error") {
        lastMsg.events = [...(lastMsg.events ?? []), ...events];
        lastMsg.content = [lastMsg.content, m.content].filter(Boolean).join("\n\n");
        const workDuration = extra?.work_duration_ms as number | undefined;
        if (workDuration !== undefined) lastMsg.workDurationMs = workDuration;
        continue;
      }
      const workDuration = extra?.work_duration_ms as number | undefined;
      msgs.push({
        id: m.id,
        role: "assistant",
        content: m.content,
        ...(events.length > 0 ? { events } : {}),
        ...(workDuration !== undefined ? { workDurationMs: workDuration } : {}),
        status: "done",
      });
      continue;
    }
    msgs.push({
      id: m.id,
      role: m.role as Msg["role"],
      content: m.content,
      ...(events.length > 0 ? { events } : {}),
      status: "done",
    });
  }
  return msgs;
}

/**
 * The chat orchestration hook — the single home for ALL conversation business
 * logic that used to live inline in Chat.tsx (~600 lines of state, stream
 * consumption, send/resolve/stop, history loading, and derived state).
 *
 * Why one hook instead of three (stream / history / actions): these concerns
 * are tightly coupled — `doStream`, `resolve`, and `send` all share `turnAcc`,
 * `abortRef`, `sessionAllowlistRef`, `resolveRef`, and the `msgs`/`busy`/`ask`
 * setters. Splitting them into separate hooks would force passing a dozen
 * shared pieces of state between hooks, obscuring the logic rather than
 * clarifying it. One cohesive hook keeps the coupling internal and gives
 * Chat.tsx a single clean surface to consume.
 *
 * The `doStream → resolve` circular dependency is broken with a ref
 * (`resolveRef`), exactly as in the original inline code: `resolveRef.current`
 * is reassigned on every render so doStream (defined before resolve) always
 * calls the latest closure.
 *
 * Inputs from the store/router are passed in; everything else (msgs, busy,
 * ask, input-bar state, model providers) is owned here.
 */
export function useChat({
  activeThreadId,
  activeWorkspaceId,
  sendWorkspaceId,
  setActiveThreadId,
  listThreads,
  endRef,
  scrollToBottom,
}: {
  activeThreadId: string | undefined;
  activeWorkspaceId: string | undefined;
  sendWorkspaceId: string | undefined;
  setActiveThreadId: (id: string | undefined) => void;
  listThreads: () => Promise<void>;
  endRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Smart follow scroll. When called with no args, scrolls to bottom ONLY if
   * the user is currently stuck to the bottom (i.e. not browsing history).
   * Pass { force: true } to always scroll (e.g. on send).
   */
  scrollToBottom: (opts?: { force?: boolean; smooth?: boolean }) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** Active ask_user_question_required payload; non-null morphs input into AskPanel. */
  const [ask, setAsk] = useState<AskUserQuestionPayload | null>(null);
  /** Session-scoped tool allowlist (approved-for-session tools auto-resolve). */
  const [sessionAllowlist, setSessionAllowlist] = useState<Set<string>>(new Set());
  const [accessMode, setAccessMode] = useState<AccessMode>("confirm");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderEntry[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [commands, setCommands] = useState<SlashCommandEntry[]>([]);

  const attachInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // textRef mirrors `text` so callbacks that fire before React re-renders
  // (e.g. slash-command auto-send) can read the latest value.
  const textRef = useRef(text);
  textRef.current = text;

  // Per-turn event accumulator. A fresh one is created at the start of each
  // assistant turn and consumed across all stream chunks.
  const turnAcc = useRef<TurnEventAccumulator | null>(null);
  // resolveRef always points at the latest `resolve` callback. doStream reaches
  // for resolve via this ref to avoid a circular useCallback dependency.
  const resolveRef = useRef<(body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => void>(() => {});
  // Mirror of sessionAllowlist for use inside doStream's auto-approve fast path.
  const sessionAllowlistRef = useRef<Set<string>>(new Set());

  // Smart follow: respects the user's scroll position. Only auto-scrolls when
  // the user is stuck to the bottom; if they've scrolled up to read history,
  // streaming output won't yank them back down.
  const scroll = useCallback(() => scrollToBottom(), [scrollToBottom]);

  // ---- Model providers (loaded once + on workspace change) ----
  const loadModelProviders = useCallback(async () => {
    try {
      const res = await sdk.listModelSettings();
      setModelProviders(res.providers.filter((p) => p.enabled && p.models.length > 0));
    } catch { /* */ }
  }, []);

  const loadCommands = useCallback(async () => {
    try {
      setCommands(await sdk.listSlashCommands("web"));
    } catch { /* */ }
  }, []);

  useEffect(() => {
    listThreads();
    loadModelProviders();
    loadCommands();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // Clear messages on workspace change.
  useEffect(() => {
    setMsgs([]);
  }, [activeWorkspaceId]);

  // ---- Thread history loading ----
  const load = useCallback(async (tid: string) => {
    // Detach any in-flight local stream FIRST: switching threads must not let
    // the old thread's events patch the new thread's message array (the
    // server-side run continues in the background regardless).
    detachLocal();
    const running = useChatStore.getState().runningThreads[tid];
    let agentFromHistory: string | undefined;
    try {
      const r = await sdk.getThreadHistory(tid);
      // Message-level agent inheritance (phase 3): sync the input bar's
      // agent selector with the thread's last user-message agent so a
      // restored session continues where it left off (e.g. plan → approved
      // → confirm carries into the next turn's default).
      const lastUser = [...(r.history ?? [])].reverse().find((m) => m.role === "user");
      const fromMsg = lastUser?.extraMetadata?.agent;
      agentFromHistory = typeof fromMsg === "string" ? fromMsg : undefined;
      if (agentFromHistory === "plan" || agentFromHistory === "auto" || agentFromHistory === "full" || agentFromHistory === "confirm") {
        setAccessMode(agentFromHistory);
      }

      if (running) {
        // The run is still executing: render messages UP TO the current turn
        // (drop the trailing in-flight turn — the /events replay rebuilds it
        // below through the same accumulator as a live turn).
        let rows = r.history ?? [];
        if (rows.length > 0) {
          const lastUserIdx = rows.map((x: any) => x.role).lastIndexOf("user");
          rows = lastUserIdx >= 0 ? rows.slice(0, lastUserIdx + 1) : [];
        }
        setMsgs(normalizeHistory(rows));
        reattachRef.current(tid);
        return;
      }

      // Finished thread — PRIMARY path is durable event replay (opencode
      // semantics: live and history run through the same reducer, so a
      // replayed thread renders identically to how it streamed, including
      // precise interleaving and subagent timelines that the messages-table
      // approximation cannot reconstruct). normalizeHistory stays as the
      // fallback for legacy threads whose delta events were compacted
      // before terminal events existed.
      const replayed = await replayThreadEvents(tid);
      setMsgs(replayed.length > 0 ? replayed : normalizeHistory(r.history ?? []));
    } catch {
      setMsgs([]);
    }
  }, []);

  /**
   * Rebuild a finished thread's full message list by replaying its durable
   * event log (GET /thread/:id/events?after=0) through TurnEventAccumulator —
   * the exact same reducer as live streaming. turn.started carries the
   * persisted userMessage, so user bubbles are reconstructed too; each
   * turn.started opens a fresh accumulator + assistant bubble. Returns [] if
   * the event log has no renderable turns (legacy pre-terminal-event threads
   * — caller falls back to the messages-table path).
   */
  const replayThreadEvents = useCallback(async (tid: string): Promise<Msg[]> => {
    let turns: Msg[] = [];
    let acc: TurnEventAccumulator | null = null;
    try {
      const stream = await sdk.streamThreadEvents(tid, 0);
      for await (const ev of stream) {
        if (ev.type === "turn.started") {
          // Close the previous turn (if any) and open a new one.
          if (acc) {
            turns[turns.length - 1] = {
              ...(turns[turns.length - 1] as Msg),
              events: acc.snapshot(),
              content: contentFromEvents(acc.snapshot()),
              status: "done",
            };
          }
          if (ev.userMessage) {
            turns.push({ id: `u_r_${ev.requestId}`, role: "user", content: ev.userMessage.content, status: "done" } as Msg);
          }
          acc = new TurnEventAccumulator();
          turns.push({ id: `a_r_${ev.requestId}`, role: "assistant", content: "", status: "streaming", events: [] } as Msg);
        } else if (acc) {
          switch (ev.type) {
            case "text.delta":
            case "reasoning.delta":
            case "text.ended":
            case "reasoning.ended":
            case "tool.started":
            case "tool.args.delta":
            case "tool.result":
            case "subagent.started":
            case "subagent.finished":
              acc.consume(ev);
              break;
            case "turn.finished":
            case "turn.interrupted":
              acc.finalizeDone();
              turns[turns.length - 1] = { ...(turns[turns.length - 1] as Msg), events: acc.snapshot(), content: contentFromEvents(acc.snapshot()), status: "done", ...(ev.type === "turn.finished" ? { workDurationMs: ev.durationMs } : {}) };
              acc = null;
              break;
            case "turn.error":
              acc.finalizeError();
              turns[turns.length - 1] = { ...(turns[turns.length - 1] as Msg), events: acc.snapshot(), status: "error" };
              acc = null;
              break;
            case "ask":
              acc.consumeAskReadOnly({ kind: ev.kind, questions: ev.questions, thread_id: tid });
              break;
            default:
              break; // heartbeat / idle / turn.started handled above
          }
        }
      }
      // Stream ended mid-turn (no terminal event — e.g. run_lost): settle it.
      if (acc) {
        acc.finalizeDone();
        turns[turns.length - 1] = { ...(turns[turns.length - 1] as Msg), events: acc.snapshot(), content: contentFromEvents(acc.snapshot()), status: "done" };
      }
    } catch {
      // Replay transport failure — signal "no replay" so caller falls back.
      return [];
    }
    // Only counts as a usable replay if at least one turn rendered content.
    return turns.some((t) => t.role === "assistant" && ((t.events?.length ?? 0) > 0 || t.content)) ? turns : [];
  }, []);

  /** Abort the local fetch + reset local stream state. The server-side run
   *  keeps executing (runs are decoupled from connections server-side). */
  const detachLocal = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    turnAcc.current = null;
    setBusy(false);
    setAsk(null);
  }, []);

  /** Clear messages (e.g. when starting a new chat via ?thread= cleared). */
  const clearMsgs = useCallback(() => setMsgs([]), []);

  // ---- Stream consumer ----
  const doStream = useCallback(async (stream: AsyncGenerator<StreamEvent>, tid: string) => {
    const setThreadRunning = useChatStore.getState().setThreadRunning;
    /** Patch the last assistant bubble's events from the accumulator snapshot. */
    const patchEvents = () => {
      const acc = turnAcc.current;
      if (!acc) return;
      const events = acc.snapshot();
      setMsgs((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (!(last?.role === "assistant" && last?.status === "streaming")) return prev;
        c[c.length - 1] = { ...last, events, content: contentFromEvents(events) };
        return c;
      });
    };
    /** Freeze the turn's work timer: prefer the server-reported duration,
     *  else the local startedAtMs elapsed. */
    const freezeTimer = (durationMs?: number) =>
      setMsgs((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (last?.role !== "assistant") return prev;
        const local =
          last.startedAtMs !== undefined ? Date.now() - last.startedAtMs : undefined;
        const chosen = durationMs ?? local;
        c[c.length - 1] = {
          ...last,
          ...(chosen !== undefined ? { workDurationMs: chosen } : {}),
        };
        return c;
      });
    try {
      for await (const ev of stream) {
        // v2 typed protocol: discriminate on `type` (legacy `status`-based
        // chunks no longer exist — server + client switched together).
        switch (ev.type) {
          case "heartbeat":
            // /events keepalive — nothing to render.
            break;
          case "idle":
            // /events stream closed with no active run: the run finished
            // before we attached (or just ended). History already has (or will
            // have, via listThreads below) the final output — clear running
            // and settle any still-streaming bubble.
            setThreadRunning(tid, false);
            freezeTimer(undefined);
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant" && last.status === "streaming") {
                c[c.length - 1] = { ...last, status: "done" };
              }
              return c;
            });
            setBusy(false);
            listThreads();
            break;
          case "turn.started": {
            // Calibrate the WorkTimer from the run's true start time (matters
            // for re-attach: the run began before this client connected).
            if (ev.runStartedAt !== undefined) {
              setMsgs((prev) => {
                const c = [...prev];
                const last = c[c.length - 1];
                if (last?.role === "assistant" && last.status === "streaming") {
                  c[c.length - 1] = { ...last, startedAtMs: ev.runStartedAt };
                }
                return c;
              });
            }
            if (!activeThreadId && ev.threadId && ev.threadId !== tid) {
              setActiveThreadId(ev.threadId);
              setThreadRunning(ev.threadId, true);
              listThreads();
            }
            break;
          }
          case "text.delta":
          case "reasoning.delta":
          case "text.ended":
          case "reasoning.ended":
          case "tool.started":
          case "tool.args.delta":
          case "tool.result":
          case "subagent.started":
          case "subagent.finished": {
            turnAcc.current?.consume(ev);
            patchEvents();
            scroll();
            break;
          }
          case "ask": {
            // Paused awaiting user input — the turn is STILL ACTIVE (the
            // server registry keeps it `paused`, /threads reports running).
            // Keep the running flag so re-entering the thread re-attaches and
            // restores this ask panel from the replay stream.
            const payload: AskUserQuestionPayload = {
              kind: ev.kind,
              questions: ev.questions,
              thread_id: ev.thread_id ?? activeThreadId ?? "",
            };
            const acc = turnAcc.current;
            if (acc) {
              acc.consumeAskReadOnly(payload);
              patchEvents();
            }
            if (payload.kind === "tool_approval") {
              const sources = payload.questions
                .map((q) => q.context?.source)
                .filter((s): s is string => !!s);
              if (sources.length > 0 && sources.every((s) => sessionAllowlistRef.current.has(s))) {
                setTimeout(() => resolveRef.current({ kind: "tool_approval", decisions: sources.map(() => ({ type: "approve" as const })) }), 0);
                return;
              }
            }
            setAsk(payload);
            return;
          }
          case "turn.finished": {
            setThreadRunning(tid, false);
            freezeTimer(ev.durationMs);
            turnAcc.current?.finalizeDone();
            patchEvents();
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") {
                c[c.length - 1] = { ...last, status: "done" };
              }
              return c;
            });
            listThreads();
            scroll(); // follow only if stuck to the bottom
            break;
          }
          case "turn.interrupted": {
            // Explicit stop (server saved partial output + emitted this).
            setThreadRunning(tid, false);
            freezeTimer(ev.durationMs);
            turnAcc.current?.finalizeDone();
            patchEvents();
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") {
                c[c.length - 1] = { ...last, status: "done" };
              }
              return c;
            });
            scroll();
            break;
          }
          case "turn.error": {
            setThreadRunning(tid, false);
            freezeTimer(undefined);
            turnAcc.current?.finalizeError();
            patchEvents();
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") {
                c[c.length - 1] = {
                  ...last,
                  status: "error",
                  error: ev.message ?? "未知错误",
                };
              }
              return c;
            });
            scroll(); // follow only if stuck to the bottom
            break;
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      turnAcc.current?.finalizeError();
      patchEvents();
      setMsgs((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (last?.role === "assistant") {
          c[c.length - 1] = {
            ...last,
            status: "error",
            error: err?.message ?? "请求失败",
          };
        }
        return c;
      });
    } finally { setBusy(false); }
  }, [activeThreadId, listThreads, setActiveThreadId, scroll]);

  // Re-attach to a running thread: append a streaming assistant bubble and
  // consume the /events replay stream through the shared doStream pipeline.
  // Reached via ref (load is defined above doStream; same pattern as resolveRef).
  const reattachRef = useRef<(tid: string) => void>(() => {});
  const reattach = useCallback(async (tid: string) => {
    setMsgs((prev) => {
      // Don't double-append if the last bubble is already a streaming turn.
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.status === "streaming") return prev;
      // startedAtMs intentionally omitted — calibrated from the replay
      // turn.started event (runStartedAt) so the timer shows the
      // run's TRUE elapsed time, not time-since-reattach.
      return [...prev, { id: `a_reattach_${Date.now()}`, role: "assistant", content: "", status: "streaming", events: [] } as Msg];
    });
    setBusy(true);
    turnAcc.current = new TurnEventAccumulator();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const stream = await sdk.streamThreadEvents(tid, 0, { signal: controller.signal });
      await doStream(stream, tid);
    } catch (err: any) {
      if (err?.name !== "AbortError") setBusy(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [doStream]);
  reattachRef.current = (tid: string) => { reattach(tid); };

  // ---- Send a new user message ----
  const send = useCallback(async (content: string) => {
    const u: Msg = { id: `u_${Date.now()}`, role: "user", content, status: "done" };
    const a: Msg = {
      id: `a_${Date.now()}`, role: "assistant", content: "", status: "streaming", events: [],
      startedAtMs: Date.now(),
    };
    setMsgs((p) => [...p, u, a]);
    setBusy(true);
    setAsk(null);
    if (activeThreadId) useChatStore.getState().setThreadRunning(activeThreadId, true);
    // User just sent a message — force follow to the bottom.
    scrollToBottom({ force: true, smooth: true });
    const controller = new AbortController();
    abortRef.current = controller;
    turnAcc.current = new TurnEventAccumulator();
    try {
      const stream = await sdk.streamAgentChat(
        {
          messages: [{ role: "user", content }],
          thread_id: activeThreadId,
          ...(sendWorkspaceId ? { workspace_id: sendWorkspaceId } : {}),
          // Agent name (successor of the access mode — same four values in
          // phase 1, see architecture/AGENT_MIGRATION_PLAN.md).
          agent: accessMode,
          ...(selectedModel ? { model: selectedModel } : {}),
        },
        { signal: controller.signal }
      );
      await doStream(stream, activeThreadId ?? "");
    } catch (err: any) {
      if (err?.name !== "AbortError") setBusy(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeThreadId, sendWorkspaceId, accessMode, selectedModel, doStream, scroll]);

  // ---- Resolve an ask_user_question_required interrupt ----
  const resolve = useCallback(
    async (body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => {
      if (!activeThreadId) return;
      if (meta?.approveForSession && body.kind === "tool_approval") {
        const sources = (ask?.questions ?? [])
          .map((q) => q.context?.source)
          .filter((s): s is string => !!s);
        if (sources.length > 0) {
          setSessionAllowlist((prev) => {
            const next = new Set(prev);
            sources.forEach((s) => next.add(s));
            sessionAllowlistRef.current = next;
            return next;
          });
        }
      }
      // Plan approved → the server flips the thread to the confirm agent.
      // Mirror that locally so the input bar's selector updates AND the next
      // message is sent with agent=confirm (otherwise /agent would sync the
      // thread BACK to plan, re-stripping the write tools mid-execution).
      if (body.kind === "plan_approval" && body.approved !== false) {
        setAccessMode("confirm");
      }
      turnAcc.current?.resolveAsk(body);
      const resolvedEvents = turnAcc.current?.snapshot();
      setMsgs((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (last?.role === "assistant" && last.status === "streaming" && resolvedEvents) {
          c[c.length - 1] = { ...last, events: resolvedEvents, content: contentFromEvents(resolvedEvents) };
        }
        return c;
      });
      setAsk(null);
      useChatStore.getState().setThreadRunning(activeThreadId, true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await doStream(
          await sdk.streamAgentResume(activeThreadId, body, { signal: controller.signal }),
          activeThreadId
        );
      } catch (err: any) {
        if (err?.name !== "AbortError") setBusy(false);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [activeThreadId, doStream, ask?.questions]
  );
  // Keep resolveRef pointed at the latest resolve so doStream always calls the
  // current closure (avoids the doStream → resolve circular dep).
  resolveRef.current = resolve;

  // ---- Stop the in-flight generation ----
  // With runs decoupled from connections, stopping requires the explicit
  // /stop endpoint: aborting the local fetch alone would only detach (the
  // run would continue in the background).
  const stop = useCallback(() => {
    const tid = activeThreadId;
    abortRef.current?.abort();
    abortRef.current = null;
    if (tid) {
      useChatStore.getState().setThreadRunning(tid, false);
      sdk.stopThreadRun(tid).catch(() => { /* server may already be done */ });
    }
    setMsgs((prev) => {
      const c = [...prev];
      const last = c[c.length - 1];
      if (last?.role === "assistant" && last?.status === "streaming") {
        c[c.length - 1] = { ...last, status: "done" };
      }
      return c;
    });
    setBusy(false);
  }, [activeThreadId]);

  // ---- Switch access mode (persisted mid-session) ----
  // Updates local state immediately AND writes the new mode to the thread on
  // the server. This is what makes a mode switch take effect at the next
  // approval point: the resume endpoint reads the persisted mode, so even an
  // in-flight turn will honor the new mode once it pauses for input. The write
  // is fire-and-forget — failures only surface in the console since the local
  // state is already the source of truth for the input bar.
  const changeAccessMode = useCallback((mode: AccessMode) => {
    setAccessMode(mode);
    const tid = activeThreadId;
    if (tid) {
      sdk.setThreadAgent(tid, mode).catch((err) => {
        // Don't surface as a user-facing error: the next /agent request also
        // syncs the agent, so a failed PATCH here is self-healing.
        console.warn("Failed to persist agent on thread", tid, err);
      });
    }
  }, [activeThreadId]);

  // ---- Attachment handling ----
  const pickAttachments = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const names = Array.from(files).map((f) => f.name);
    setAttachments((prev) => [...prev, ...names]);
    e.target.value = "";
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, j) => j !== index));
  }, []);

  // ---- Slash command selection ----
  const onSlashSelect = useCallback(
    (cmd: SlashCommandEntry) => {
      if (cmd.action === "send") {
        setTimeout(() => {
          const t = textRef.current.trim();
          if (!t || busy) return;
          setText("");
          send(t);
        }, 0);
      }
    },
    [busy, send, setText],
  );

  // ---- System command dispatcher ----
  const handleSystemCommand = useCallback(
    (cmd: SlashCommandEntry) => {
      const action = cmd.systemAction;
      if (!action) return;

      // Object actions (navigate)
      if (typeof action === "object" && "type" in action) {
        if (action.type === "navigate") {
          window.location.href = action.path;
        }
        return;
      }

      // String actions
      switch (action as string) {
        case "clear":
          setMsgs([]);
          setActiveThreadId(undefined);
          break;
        case "theme": {
          const { mode, setMode } = useThemeStore.getState();
          const next =
            mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
          setMode(next);
          antdMessage.success(`主题已切换为 ${next === "light" ? "浅色" : next === "dark" ? "深色" : "跟随系统"}`);
          break;
        }
        case "search":
          // Dispatch a custom event that Sidebar listens for to open the
          // global search modal. Fallback: Ctrl+K simulation.
          window.dispatchEvent(new CustomEvent("octopus:open-search"));
          break;
        case "copy-last": {
          const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
          if (lastAssistant?.content) {
            navigator.clipboard.writeText(lastAssistant.content).then(
              () => antdMessage.success("已复制到剪贴板"),
              () => antdMessage.error("复制失败"),
            );
          } else {
            antdMessage.warning("没有可复制的内容");
          }
          break;
        }
        case "help":
          antdMessage.info("快捷键：Enter 发送，Shift+Enter 换行，Shift+Tab 切换模式，Ctrl+K 搜索，/ 打开命令菜单");
          break;
        case "changelog":
          window.open("https://github.com/octopus/changelog", "_blank");
          break;
        case "version":
          antdMessage.info("Octopus v0.1.0");
          break;
        case "feedback":
          window.open("https://github.com/octopus/issues", "_blank");
          break;
        case "docs":
          window.open("https://docs.octopus.dev", "_blank");
          break;
        // TUI-only commands — no-op on web
        default:
          break;
      }
    },
    [msgs, setActiveThreadId],
  );

  // ---- Input send + keyboard ----
  const doSend = useCallback(() => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    send(t);
  }, [text, busy, send]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); return; }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const i = MODE_ORDER.indexOf(accessMode);
      changeAccessMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
    }
  }, [doSend, accessMode, changeAccessMode]);

  // ---- Derived state ----
  const showStart = msgs.length === 0;

  /** Latest todo list (last write_todos in the last assistant turn). */
  const todos: TodoItem[] = useMemo(() => {
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const m = msgs[mi];
      if (m.role !== "assistant" || !m.events) continue;
      for (let ei = m.events.length - 1; ei >= 0; ei--) {
        const ev = m.events[ei];
        if (ev.type === "tool" && ev.entry.name === "write_todos") {
          const t = ev.entry.args?.todos;
          if (Array.isArray(t)) return t as TodoItem[];
        }
      }
    }
    return [];
  }, [msgs]);

  /** All SubagentEvents flattened across the conversation (for the side panel). */
  const allSubagents = useMemo<SubagentEvent[]>(
    () =>
      msgs.flatMap((m) =>
        (m.events ?? []).filter((e): e is SubagentEvent => e.type === "subagent"),
      ),
    [msgs],
  );

  /** Grouped model options: one "默认" entry + a group per provider. */
  const modelOptions = useMemo(() => {
    const groups: Array<{ label: string; options: Array<{ label: string; value: string }> }> = [];
    for (const p of modelProviders) {
      groups.push({
        label: p.displayName || p.name,
        options: p.models.map((m) => ({
          label: `${p.name}:${m}`,
          value: `${p.name}:${m}`,
        })),
      });
    }
    return groups;
  }, [modelProviders]);

  return {
    // state
    msgs, text, setText, busy, ask, sessionAllowlist, accessMode, setAccessMode: changeAccessMode,
    selectedModel, setSelectedModel, attachments, modelOptions, todos, allSubagents, showStart,
    attachInputRef, commands,
    // actions
    send, resolve, stop, doSend, onKey, load, clearMsgs, pickAttachments, removeAttachment,
    onSlashSelect, handleSystemCommand,
  };
}
