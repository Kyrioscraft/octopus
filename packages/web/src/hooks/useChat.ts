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
  /** Last wire-event seq consumed for the active thread — resume subscribes
   *  after this (re-consuming the pre-ask timeline would duplicate blocks
   *  and re-pop a resolved ask panel). */
  const lastSeqRef = useRef<number>(0);
  /** Threads mid-hydration (snapshot fetch in flight) — opencode's
   *  hydratingSessions pattern: guards against stampeding loads on the same
   *  thread and lets other paths know a snapshot may land late. */
  const hydratingRef = useRef<Set<string>>(new Set());
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
    hydratingRef.current.add(tid);
    try {
      // P1 snapshot hydration: ONE atomic response with the durable events,
      // the server-authoritative cursor (maxSeq — covers live volatile seqs
      // too, so the client never tracks its own), and the trailing pending
      // ask. This replaces both the /history + /events?after=0 replay path.
      const snap = await sdk.getThreadSnapshot(tid);
      // Restore the input bar's agent selector (snapshot agent is the
      // thread-level access_mode — most authoritative after an explicit
      // switch; falls back through thread list → last user-message metadata).
      const isAgent = (v: unknown): v is AccessMode =>
        v === "plan" || v === "confirm" || v === "auto" || v === "full";
      const fromThreadList =
        useChatStore.getState().threads.find((t) => t.id === tid)?.accessMode;
      const restored = isAgent(snap.agent) ? snap.agent
        : isAgent(fromThreadList) ? fromThreadList
        : undefined;
      if (restored) setAccessMode(restored);

      // Messages-table fallback (pre-upgrade turns whose deltas were
      // compacted with no terminal events to replace them): kept for the
      // per-turn hybrid merge inside projectSnapshot.
      let normalized: Msg[] = [];
      try {
        const r = await sdk.getThreadHistory(tid);
        normalized = normalizeHistory(r.history ?? []);
        if (!restored) {
          const lastUser = [...(r.history ?? [])].reverse().find((m) => m.role === "user");
          const fromMsg = lastUser?.extraMetadata?.agent;
          if (isAgent(fromMsg)) setAccessMode(fromMsg);
        }
      } catch { /* snapshot alone is enough for the main path */ }

      const { msgs, openAcc } = projectSnapshot(tid, snap.events, normalized);
      setMsgs(msgs.length > 0 ? msgs : normalized);
      // Stateless cursor: the SERVER's maxSeq is authoritative (covers
      // volatile seqs already assigned to the live run). Never trust a
      // locally accumulated cursor here.
      lastSeqRef.current = snap.maxSeq;

      if (snap.pendingAsk) {
        // Paused at an unanswered ask (live OR after a server restart —
        // recovery truth is the durable log, not the run registry). Restore
        // the interactive state; resolving continues from maxSeq.
        if (openAcc) turnAcc.current = openAcc;
        setAsk({ ...snap.pendingAsk, thread_id: tid });
        setBusy(true);
      }

      if (snap.running) {
        // Live run executing: keep the running flag and tail live events
        // from the snapshot cursor. The trailing in-flight turn (if any) is
        // already part of the projected bubbles (openAcc holds it).
        useChatStore.getState().setThreadRunning(tid, true);
        setBusy(true);
        if (openAcc) turnAcc.current = openAcc;
        reattachRef.current(tid);
      }
    } catch {
      setMsgs([]);
    } finally {
      hydratingRef.current.delete(tid);
    }
  }, []);

  /**
   * Project a snapshot's durable events into message bubbles — the SAME
   * per-turn reducer logic live streaming uses (TurnEventAccumulator), so
   * history renders identically to how the turn streamed. Pure-ish: builds a
   * fresh turns array; returns the still-open accumulator when the snapshot
   * ends mid-turn (running or paused-at-ask) so live tailing continues the
   * same turn instead of opening a duplicate bubble.
   *
   * Per-turn hybrid fallback: turns with no replayable content (pre-upgrade
   * compaction) fall back to the messages-table rendering.
   */
  const projectSnapshot = (
    tid: string,
    events: StreamEvent[],
    normalizedRows: Msg[],
  ): { msgs: Msg[]; openAcc: TurnEventAccumulator | null } => {
    let turns: Msg[] = [];
    let acc: TurnEventAccumulator | null = null;
    const settleTurn = (patch: Partial<Msg>, finalize: (a: TurnEventAccumulator) => void) => {
      if (!acc) return;
      finalize(acc);
      const evs = acc.snapshot();
      const cur = turns[turns.length - 1] as Msg | undefined;
      const elapsed =
        patch.workDurationMs === undefined && cur?.startedAtMs !== undefined
          ? Date.now() - cur.startedAtMs
          : undefined;
      turns[turns.length - 1] = {
        ...(cur as Msg),
        events: evs,
        content: contentFromEvents(evs),
        status: "done",
        ...patch,
        ...(elapsed !== undefined && patch.workDurationMs === undefined ? { workDurationMs: elapsed } : {}),
      };
      acc = null;
    };
    for (const ev of events) {
      if (ev.type === "turn.started") {
        // Resume turns carry no userMessage — they CONTINUE the same turn.
        // Only a fresh turn (or a snapshot starting mid-run) opens a bubble.
        if (ev.userMessage || !acc) {
          settleTurn({}, (a) => a.finalizeDone());
          if (ev.userMessage) {
            const content = typeof ev.userMessage === "string"
              ? ev.userMessage
              : (ev.userMessage as { content?: string }).content ?? "";
            turns.push({ id: `u_r_${ev.requestId}`, role: "user", content, status: "done" } as Msg);
          }
          acc = new TurnEventAccumulator();
          turns.push({
            id: `a_r_${ev.requestId}`,
            role: "assistant",
            content: "",
            status: "streaming",
            events: [],
            startedAtMs: ev.runStartedAt,
          } as Msg);
        } else if (ev.runStartedAt !== undefined) {
          const cur = turns[turns.length - 1] as Msg | undefined;
          if (cur?.role === "assistant") turns[turns.length - 1] = { ...cur, startedAtMs: ev.runStartedAt };
        }
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
            settleTurn({ workDurationMs: ev.durationMs }, (a) => a.finalizeDone());
            break;
          case "turn.interrupted":
            settleTurn({ workDurationMs: ev.durationMs }, (a) => a.finalizeDone());
            break;
          case "turn.error":
            settleTurn({}, (a) => a.finalizeError());
            break;
          case "thread.title.updated":
            break; // sidebar metadata — listThreads covers it
          case "ask":
            acc.consumeAskReadOnly({ kind: ev.kind, questions: ev.questions, thread_id: tid });
            break;
          case "ask.resolved":
            acc.resolveAsk(ev.resolution);
            break;
          default:
            break;
        }
      }
    }
    // Snapshot ends mid-turn (running / paused-at-ask): keep the turn open —
    // the caller hands the accumulator to the live tail.
    if (acc) {
      const evs = acc.snapshot();
      const cur = turns[turns.length - 1] as Msg | undefined;
      if (cur?.role === "assistant") {
        turns[turns.length - 1] = { ...cur, events: evs, content: contentFromEvents(evs) };
      }
      return { msgs: turns, openAcc: acc };
    }
    settleTurn({}, (a) => a.finalizeDone());

    // ---- Per-turn hybrid merge (pre-upgrade turns without terminal events) ----
    const fallbackAssistantTurns = normalizedRows.filter((m) => m.role === "assistant");
    let fbIdx = 0;
    const merged = turns.map((t) => {
      if (t.role !== "assistant") return t;
      const hasReplay = (t.events?.length ?? 0) > 0 || !!t.content;
      const fb = fallbackAssistantTurns[fbIdx];
      fbIdx++;
      if (hasReplay || !fb) return t;
      return { ...fb, startedAtMs: fb.startedAtMs ?? t.startedAtMs, workDurationMs: fb.workDurationMs ?? t.workDurationMs };
    });
    const usable = merged.some((t) => t.role === "assistant" && ((t.events?.length ?? 0) > 0 || t.content));
    return { msgs: usable ? merged : [], openAcc: null };
  };

  /** Abort the local fetch + reset local stream state. The server-side run
   *  keeps executing (runs are decoupled from connections server-side). */
  const detachLocal = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    turnAcc.current = null;
    // Detach happens on thread switch — the next attach/replay starts from
    // seq 0 for the (possibly different) thread.
    lastSeqRef.current = 0;
    setBusy(false);
    setAsk(null);
  }, []);

  /** Clear messages (e.g. when starting a new chat via ?thread= cleared).
   *  MUST also reset the local cursor/accumulator — a new thread's seq
   *  restarts at 1, and a leftover cursor from the previous thread (e.g.
   *  33850) makes send() subscribe with after=<stale>, so the server-side
   *  filter drops EVERY event of the new thread (blank live output, only
   *  the timer running). Same reset as detachLocal. */
  const clearMsgs = useCallback(() => {
    setMsgs([]);
    lastSeqRef.current = 0;
    turnAcc.current = null;
  }, []);

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
        // Track the high-water seq so a resume can subscribe after it
        // (instead of replaying the whole turn into the same accumulator).
        // ONLY persisted data events carry a real seq — idle/heartbeat are
        // connection control frames; absorbing a synthetic seq would inflate
        // the cursor and silently drop the next run's first events.
        if (ev.type !== "idle" && ev.type !== "heartbeat" && ev.seq > lastSeqRef.current) {
          lastSeqRef.current = ev.seq;
        }
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
          case "thread.title.updated": {
            // New-thread auto-title landed (background task from the server,
            // usually seconds into the first turn) — refresh the sidebar list.
            // The server DB is already updated; listThreads() picks it up.
            listThreads();
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
          case "ask.resolved": {
            // The user's answer, persisted by POST /resume before the resumed
            // run's events. Clear the panel and mark the timeline ask done —
            // replayed/live consumers use this instead of inferring.
            setAsk(null);
            turnAcc.current?.resolveAsk(ev.resolution);
            patchEvents();
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
            // Do NOT return here: the deepagents graph may keep streaming
            // after the ask (agent continues its turn), and the /events
            // stream stays open until the server sees the run paused. Those
            // trailing events MUST keep flowing into this loop — both to
            // render them and to advance lastSeqRef — otherwise the resume
            // subscription (after=lastSeqRef) would replay them into the
            // accumulator a second time (the duplicated text/tools bug).
            break;
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
      // Transport failure (server restart / network drop mid-stream). The
      // run's fate is unknown — clear the local running flag so the sidebar
      // spinner doesn't spin forever (the next /threads poll or re-entry
      // re-marks it if the run is genuinely still alive server-side).
      useChatStore.getState().setThreadRunning(tid, false);
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

  // Re-attach to a running thread: P1 — the snapshot (load) already hydrated
  // everything durable INCLUDING the in-flight turn (openAcc), so this is now
  // a pure LIVE TAIL from the server cursor. No from-0 replay, no duplicate
  // bubble (only appended when no streaming bubble exists — e.g. a run whose
  // turn.started hasn't been observed yet).
  const reattachRef = useRef<(tid: string) => void>(() => {});
  const reattach = useCallback(async (tid: string) => {
    setMsgs((prev) => {
      // Don't double-append if the last bubble is already a streaming turn.
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.status === "streaming") return prev;
      return [...prev, { id: `a_reattach_${Date.now()}`, role: "assistant", content: "", status: "streaming", events: [] } as Msg];
    });
    setBusy(true);
    if (!turnAcc.current) turnAcc.current = new TurnEventAccumulator();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // after = lastSeqRef (set to the snapshot's server-authoritative maxSeq
      // by load) — live events only, never a replay into the hydrated state.
      const stream = await sdk.streamThreadEvents(tid, lastSeqRef.current, { signal: controller.signal });
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
        // Subscribe after the events of earlier turns this client already
        // rendered — a full replay would pour the whole thread into the new
        // turn's bubble. (For a brand-new thread lastSeqRef is 0 anyway.)
        { signal: controller.signal, after: lastSeqRef.current }
      );
      await doStream(stream, activeThreadId ?? "");
    } catch (err: any) {
      if (err?.name !== "AbortError") setBusy(false);
      // 409 thread_busy: another run is active on this thread (possibly from
      // another client). Roll back the optimistic user/assistant bubbles and
      // surface the conflict instead of leaving a phantom streaming turn.
      if (err?.status === 409 || /thread_busy|正在执行/i.test(String(err?.message ?? ""))) {
        setMsgs((prev) => {
          // Drop the trailing assistant placeholder we appended; keep the
          // user's text visible but mark the turn errored with the reason.
          const c = [...prev];
          const last = c[c.length - 1];
          if (last?.role === "assistant" && last.status === "streaming") c.pop();
          const nowLast = c[c.length - 1];
          if (nowLast?.role === "assistant") {
            c[c.length - 1] = { ...nowLast, status: "error", error: err?.message ?? "该对话正在执行中，请等待完成或先停止" };
          }
          return c;
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeThreadId, sendWorkspaceId, accessMode, selectedModel, doStream, scroll]);

  // ---- Resolve an ask_user_question_required interrupt ----
  const resolve = useCallback(
    async (body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => {
      if (!activeThreadId) {
        // Should not happen while the panel is visible — surface it instead
        // of silently dropping the user's answer.
        console.warn("[useChat] resolve called without an active thread; answer dropped", body);
        setAsk(null);
        return;
      }
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
        if (last?.role === "assistant" && resolvedEvents) {
          // Re-open the LIVE rendering channel: the ask paused the /events
          // stream, whose `idle` terminator settled this bubble as "done" —
          // patchEvents() refuses to write into a non-streaming bubble, so
          // without flipping the status back the resume's events would
          // consume into the accumulator but never render (blank until the
          // next full replay). Terminal status is re-settled by the resume's
          // own turn.finished / turn.error / idle.
          c[c.length - 1] = {
            ...last,
            status: "streaming",
            events: resolvedEvents,
            content: contentFromEvents(resolvedEvents),
          };
        }
        return c;
      });
      setBusy(true);
      setAsk(null);
      useChatStore.getState().setThreadRunning(activeThreadId, true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await doStream(
          // Subscribe AFTER the pre-ask events already rendered — re-consuming
          // them would duplicate tool/text blocks in the same accumulator and
          // re-pop the just-resolved ask panel.
          await sdk.streamAgentResume(activeThreadId, body, { signal: controller.signal, after: lastSeqRef.current }),
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
