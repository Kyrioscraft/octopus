import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  OctopusClient,
  type StreamEvent,
  type ModelProviderEntry,
  type AskUserQuestionPayload,
  type AskQuestion,
  type ResumeRequestBody,
} from "@octopus/tentacle";
import { TurnEventAccumulator, contentFromEvents } from "../components/chat/turn/TurnEventAccumulator.js";
import type { TurnEvent, SubagentEvent } from "../components/chat/turn/types.js";
import type { ToolCallEntry } from "../components/chat/rows/tools/types.js";
import type { TodoItem } from "../components/chat/companion/types.js";
import type { Msg } from "../components/chat/types.js";
import type { AccessMode } from "../components/chat/constants.js";
import { MODE_ORDER } from "../components/chat/constants.js";

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
  const msgs: Msg[] = [];
  for (const m of rows) {
    if (m.role === "tool") continue;
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
}: {
  activeThreadId: string | undefined;
  activeWorkspaceId: string | undefined;
  sendWorkspaceId: string | undefined;
  setActiveThreadId: (id: string | undefined) => void;
  listThreads: () => Promise<void>;
  endRef: React.RefObject<HTMLDivElement | null>;
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

  const attachInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Per-turn event accumulator. A fresh one is created at the start of each
  // assistant turn and consumed across all stream chunks.
  const turnAcc = useRef<TurnEventAccumulator | null>(null);
  // resolveRef always points at the latest `resolve` callback. doStream reaches
  // for resolve via this ref to avoid a circular useCallback dependency.
  const resolveRef = useRef<(body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => void>(() => {});
  // Mirror of sessionAllowlist for use inside doStream's auto-approve fast path.
  const sessionAllowlistRef = useRef<Set<string>>(new Set());

  const scroll = useCallback(
    () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50),
    [endRef],
  );

  // ---- Model providers (loaded once + on workspace change) ----
  const loadModelProviders = useCallback(async () => {
    try {
      const res = await sdk.listModelSettings();
      setModelProviders(res.providers.filter((p) => p.enabled && p.models.length > 0));
    } catch { /* */ }
  }, []);

  useEffect(() => {
    listThreads();
    loadModelProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // Clear messages on workspace change.
  useEffect(() => {
    setMsgs([]);
  }, [activeWorkspaceId]);

  // ---- Thread history loading ----
  const load = useCallback(async (tid: string) => {
    try {
      const r = await sdk.getThreadHistory(tid);
      setMsgs(normalizeHistory(r.history ?? []));
    } catch { setMsgs([]); }
  }, []);

  /** Clear messages (e.g. when starting a new chat via ?thread= cleared). */
  const clearMsgs = useCallback(() => setMsgs([]), []);

  // ---- Stream consumer ----
  const doStream = useCallback(async (stream: AsyncGenerator<StreamEvent>, tid: string) => {
    try {
      for await (const ev of stream) {
        switch (ev.status) {
          case "init":
            if (!activeThreadId && ev.meta?.thread_id) {
              setActiveThreadId(ev.meta?.thread_id as string);
              listThreads();
            }
            break;
          case "loading":
          case "reasoning": {
            const acc = turnAcc.current;
            if (!acc) break;
            const tok = typeof ev.response === "string" ? ev.response : "";
            acc.consume({
              text: tok,
              isReasoning: ev.status === "reasoning",
              msgType: ev.msg?.type as string | undefined,
              toolCalls:
                (ev.msg?.tool_calls as Array<Record<string, unknown>> | undefined) ?? undefined,
              toolCallChunks:
                (ev.msg?.tool_call_chunks as
                  | Array<{ name?: string; args?: string; index?: string | number; id?: string }>
                  | undefined) ?? undefined,
              toolCallId: ev.msg?.tool_call_id as string | undefined,
              agentNs: ev.msg?.agent_ns as string | undefined,
              agentName: ev.msg?.agent_name as string | undefined,
              description: ev.msg?.description as string | undefined,
            });
            const events = acc.snapshot();
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (!(last?.role === "assistant" && last?.status === "streaming")) return prev;
              c[c.length - 1] = { ...last, events, content: contentFromEvents(events) };
              return c;
            });
            scroll();
            break;
          }
          case "ask_user_question_required": {
            const kind = (ev.kind as AskUserQuestionPayload["kind"] | undefined) ?? "tool_approval";
            const questions = (ev.questions as AskQuestion[] | undefined) ?? [];
            const payload: AskUserQuestionPayload = {
              kind,
              questions,
              thread_id: (ev.thread_id as string | undefined) ?? activeThreadId ?? "",
            };
            const acc = turnAcc.current;
            if (acc) {
              acc.consumeAskReadOnly(payload);
              const events = acc.snapshot();
              setMsgs((prev) => {
                const c = [...prev];
                const last = c[c.length - 1];
                if (!(last?.role === "assistant" && last?.status === "streaming")) return prev;
                c[c.length - 1] = { ...last, events, content: contentFromEvents(events) };
                return c;
              });
            }
            if (kind === "tool_approval") {
              const sources = questions
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
          case "finished": {
            const acc = turnAcc.current;
            acc?.finalizeDone();
            const events = acc?.snapshot();
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") {
                c[c.length - 1] = {
                  ...last,
                  status: "done",
                  ...(events ? { events, content: contentFromEvents(events) } : {}),
                };
              }
              return c;
            });
            listThreads();
            break;
          }
          case "error": {
            const acc = turnAcc.current;
            acc?.finalizeError();
            const events = acc?.snapshot();
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") {
                c[c.length - 1] = {
                  ...last,
                  status: "error",
                  error: ev.error_message ?? "未知错误",
                  ...(events ? { events, content: contentFromEvents(events) } : {}),
                };
              }
              return c;
            });
            break;
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      const acc = turnAcc.current;
      acc?.finalizeError();
      const events = acc?.snapshot();
      setMsgs((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (last?.role === "assistant") {
          c[c.length - 1] = {
            ...last,
            status: "error",
            error: err?.message ?? "请求失败",
            ...(events ? { events, content: contentFromEvents(events) } : {}),
          };
        }
        return c;
      });
    } finally { setBusy(false); }
  }, [activeThreadId, listThreads, setActiveThreadId, scroll]);

  // ---- Send a new user message ----
  const send = useCallback(async (content: string) => {
    const u: Msg = { id: `u_${Date.now()}`, role: "user", content, status: "done" };
    const a: Msg = { id: `a_${Date.now()}`, role: "assistant", content: "", status: "streaming", events: [] };
    setMsgs((p) => [...p, u, a]);
    setBusy(true);
    setAsk(null);
    scroll();
    const controller = new AbortController();
    abortRef.current = controller;
    turnAcc.current = new TurnEventAccumulator();
    try {
      const stream = await sdk.streamAgentChat(
        {
          messages: [{ role: "user", content }],
          thread_id: activeThreadId,
          ...(sendWorkspaceId ? { workspace_id: sendWorkspaceId } : {}),
          mode: accessMode,
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
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMsgs((prev) => {
      const c = [...prev];
      const last = c[c.length - 1];
      if (last?.role === "assistant" && last?.status === "streaming") {
        c[c.length - 1] = { ...last, status: "done" };
      }
      return c;
    });
    setBusy(false);
  }, []);

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
      sdk.setThreadMode(tid, mode).catch((err) => {
        // Don't surface as a user-facing error: the next /agent request also
        // syncs the mode, so a failed PATCH here is self-healing.
        console.warn("Failed to persist access mode on thread", tid, err);
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
    attachInputRef,
    // actions
    send, resolve, stop, doSend, onKey, load, clearMsgs, pickAttachments, removeAttachment,
  };
}
