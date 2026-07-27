import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Input, Button, Tooltip, Popover, Select, Tag, message as antdMessage } from "antd";
import {
  ArrowUpOutlined, PauseOutlined,
  PaperClipOutlined,
  GithubOutlined,
  DesktopOutlined, CloudServerOutlined, PlusOutlined,
  FileAddOutlined, PictureOutlined,
  EyeOutlined, LockOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import {
  OctopusClient,
  type StreamEvent,
  type Workspace,
  type ModelProviderEntry,
  type AskUserQuestionPayload,
  type AskQuestion,
  type ResumeRequestBody,
} from "@octopus/tentacle";
import { useChatStore } from "../stores/chat.js";
import { useSearchParams } from "react-router-dom";
import { AskPanel } from "../components/AskPanel.js";
import { Markdown } from "../components/Markdown.js";
import { TurnTimeline } from "../components/toolcalls/TurnTimeline.js";
import { TurnEventAccumulator, contentFromEvents } from "../components/toolcalls/TurnEventAccumulator.js";
import type { ToolCallEntry, TurnEvent } from "../components/toolcalls/types.js";

const { TextArea } = Input;
const sdk = new OctopusClient();

// Input toolbar access modes. Aligned with ChatRequest.mode on the server side
// (tentacle types); only confirm/auto currently alter graph behavior, plan is
// read-only planning. This table centralizes the per-mode UX (icon, copy,
// border color, dangerous flag) so the Select, textarea, and warning banner
// all stay in sync.
type AccessMode = "plan" | "confirm" | "auto";
const ACCESS_MODES: Record<AccessMode, {
  icon: React.ReactNode;
  label: string;
  hint: string;
  placeholder: string;
  borderColor: string;
  dangerous: boolean;
}> = {
  plan: {
    icon: <EyeOutlined />,
    label: "计划模式",
    hint: "只规划，不执行变更",
    placeholder: "描述你想要的方案，我只规划不执行…",
    borderColor: "var(--gray-150)",
    dangerous: false,
  },
  confirm: {
    icon: <LockOutlined />,
    label: "变更确认",
    hint: "每步变更都请你确认",
    placeholder: "描述变更，我会逐步请你确认…",
    borderColor: "var(--main-500)",
    dangerous: false,
  },
  auto: {
    icon: <ThunderboltOutlined />,
    label: "自动编辑",
    hint: "全自动执行变更",
    placeholder: "描述任务，我将自动执行…",
    borderColor: "var(--main-color)",
    dangerous: true,
  },
};
// Cycle order for the Shift+Tab shortcut: plan -> confirm -> auto -> plan.
const MODE_ORDER: AccessMode[] = ["plan", "confirm", "auto"];

const greetings = [
  "👋 您好，有什么可以帮您？",
  "👋 你好！有什么想聊的吗？",
  "👋 嘿，有什么我可以帮助你的？",
  "👋 欢迎！今天想讨论什么话题？",
  "👋 你好呀，随时为你服务！",
];

const exampleQuestions = [
  "帮我写一个 Python 脚本",
  "解释一下什么是 LangGraph",
  "帮我分析和优化这段代码",
];

interface Msg {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  status?: string;
  /**
   * Ordered timeline of events for this assistant turn (reasoning / tool /
   * text / subagent), in real execution order. Replaces the old flat
   * reasoning/content/toolCalls fields as the source of truth for rendering.
   * `content` is kept in sync for backwards-compat with persistence and any
   * code that still reads it.
   */
  events?: TurnEvent[];
  /** Legacy error hint (rendered outside the timeline). */
  error?: string;
}

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const {
    threads, activeThreadId, setActiveThreadId, setThreads,
    workspaces, activeWorkspaceId,
    fileTreeCollapsed, setFileTreeCollapsed,
  } = useChatStore();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Active ask_user_question_required payload. While non-null, the input-area
   * morphs into <AskPanel> (the text textarea is locked by `busy`). Cleared
   * on resolve. Typed via the wire shape from tentacle.
   */
  const [ask, setAsk] = useState<AskUserQuestionPayload | null>(null);
  /**
   * Session-scoped tool allowlist — tools the user has "approved for this
   * session" via AskPanel. Future tool_approval interrupts for these tools
   * auto-resolve without showing the panel. Lost on page refresh (not
   * persisted — that's a future DB/settings feature).
   */
  const [sessionAllowlist, setSessionAllowlist] = useState<Set<string>>(new Set());
  const [greeting] = useState(() => greetings[Math.floor(Math.random() * greetings.length)]);
  // Input toolbar state.
  const [accessMode, setAccessMode] = useState<AccessMode>("confirm");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProviderEntry[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  // Hidden file input for attachments (the directory browser uses its own modal).
  const attachInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // AbortController for the in-flight stream. Clicking the stop button
  // aborts it; the server sees the disconnect and persists partial output
  // (chat_service.py handles asyncio.CancelledError).
  const abortRef = useRef<AbortController | null>(null);

  // The active workspace comes from the store (selected in the sidebar). New
  // conversations are bound to it; existing threads keep their own binding.
  const threadWorkspaceId = useMemo(
    () => threads.find((t) => t.id === activeThreadId)?.workspaceId ?? null,
    [threads, activeThreadId],
  );
  const activeWorkspace = useMemo<Workspace | null>(() => {
    const id = threadWorkspaceId ?? activeWorkspaceId;
    return workspaces.find((w) => w.id === id) ?? null;
  }, [workspaces, threadWorkspaceId, activeWorkspaceId]);

  // The workspace id to forward with the next message.
  const sendWorkspaceId = threadWorkspaceId ?? activeWorkspaceId;

  const listThreads = useCallback(async () => {
    // Scope to the active workspace when one is selected (matches the sidebar).
    const scope = activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined;
    try { setThreads(await sdk.listThreads(scope)); } catch { /* */ }
  }, [setThreads, activeWorkspaceId]);

  const loadModelProviders = useCallback(async () => {
    try {
      const res = await sdk.listModelSettings();
      setModelProviders(res.providers.filter((p) => p.enabled && p.models.length > 0));
    } catch { /* */ }
  }, []);

  useEffect(() => {
    listThreads();
    loadModelProviders();
    // Re-run when the active workspace changes so the thread list refreshes to
    // match the new workspace (no full page reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // When the active workspace changes, clear any open conversation's messages
  // so the previous workspace's thread doesn't linger under the new one.
  useEffect(() => {
    setMsgs([]);
  }, [activeWorkspaceId]);

  // React to `?thread=` query changes (SPA navigation between conversations).
  // On a fresh thread id, set it active + load its history; when the query is
  // cleared (new chat), clear messages so the start screen shows.
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (threadParam) {
      setActiveThreadId(threadParam);
      load(threadParam);
    } else {
      setActiveThreadId(undefined);
      setMsgs([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadParam]);

  const load = useCallback(async (tid: string) => {
    try {
      const r = await sdk.getThreadHistory(tid);
      const rows = r.history ?? [];
      // Two-pass normalization: tool messages (role:"tool") are stored as
      // independent rows carrying extraMetadata.tool_call_id. We pair them
      // back into the originating assistant message's tool call result and
      // drop the standalone tool rows so they don't render as bubbles.
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
        // Reconstruct an ordered events[] timeline from the persisted fields.
        // Historical data lost the precise interleaving order (we only stored
        // merged reasoning + a tool_calls array + the final content), so we
        // rebuild a best-effort sequence: reasoning first, then tool calls,
        // then the text reply. Live turns preserve true order via the
        // TurnEventAccumulator.
        const events: TurnEvent[] = [];
        let seq = 0;
        if (reasoning) {
          events.push({
            id: `${m.id}_rs_${seq++}`,
            type: "reasoning",
            text: reasoning,
            startedAt: 0,
          });
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            events.push({ id: `${m.id}_te_${seq++}`, type: "tool", entry: tc });
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
      setMsgs(msgs);
    } catch { setMsgs([]); }
  }, []);

  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  // Per-turn event accumulator. A fresh one is created at the start of each
  // assistant turn (in send/resume) and consumed across all stream chunks,
  // producing an ordered TurnEvent[] timeline that preserves real execution
  // order (reasoning → tool → reasoning → tool → reply).
  const turnAcc = useRef<TurnEventAccumulator | null>(null);
  /**
   * resolveRef always points at the latest `resolve` callback. doStream (which
   * is defined BEFORE resolve in the file) reaches for resolve via this ref to
   * avoid a circular useCallback dependency (doStream → resolve → doStream)
   * and the stale-closure trap that would otherwise freeze `ask` / the
   * session allowlist to their first-render values.
   */
  const resolveRef = useRef<(body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => void>(() => {});
  /**
   * Mirror of `sessionAllowlist` for use inside doStream's auto-approve fast
   * path (same stale-closure reason as resolveRef).
   */
  const sessionAllowlistRef = useRef<Set<string>>(new Set());

  // Stream consumer — defined inline to capture closure state
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
            // Build the typed payload. Discriminant: ev.kind (from server
            // buildAskPayload) wins; fallback to "tool_approval".
            const kind = (ev.kind as AskUserQuestionPayload["kind"] | undefined) ?? "tool_approval";
            const questions = (ev.questions as AskQuestion[] | undefined) ?? [];
            const payload: AskUserQuestionPayload = {
              kind,
              questions,
              thread_id: (ev.thread_id as string | undefined) ?? activeThreadId ?? "",
            };

            // Leave a read-only trace in the timeline so the user can see
            // "the agent paused here to ask me something" even after the
            // AskPanel is dismissed.
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

            // Session-allowlist fast path: tool_approval for a tool the user
            // already approved-for-session auto-resolves without showing the
            // panel. This keeps interactive sessions smooth once trust is
            // established for a given tool.
            if (kind === "tool_approval") {
              const sources = questions
                .map((q) => q.context?.source)
                .filter((s): s is string => !!s);
              if (sources.length > 0 && sources.every((s) => sessionAllowlistRef.current.has(s))) {
                // Defer the auto-resolve so React can flush the trace first.
                // Use resolveRef to dodge the doStream → resolve circular dep.
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
            // The server now generates the title BEFORE emitting the finished
            // chunk and writes it to the DB, so a single listThreads() here
            // picks up the updated title. The old setTimeout(…, 3000) re-poll
            // is no longer needed.
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
      // AbortError is expected when the user clicks stop — leave the bubble
      // state as `stop()` set it.
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
  }, [activeThreadId, listThreads, setActiveThreadId]);

  const send = useCallback(async (content: string) => {
    const u: Msg = { id: `u_${Date.now()}`, role: "user", content, status: "done" };
    const a: Msg = { id: `a_${Date.now()}`, role: "assistant", content: "", status: "streaming", events: [] };
    setMsgs((p) => [...p, u, a]);
    setBusy(true);
    setAsk(null);
    scroll();
    const controller = new AbortController();
    abortRef.current = controller;
    // Fresh accumulator for this turn.
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
      // AbortError is expected when the user clicks stop — don't surface it.
      if (err?.name !== "AbortError") setBusy(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeThreadId, sendWorkspaceId, accessMode, selectedModel, doStream]);

  /**
   * Resolve the active ask_user_question_required: send the user's answer to
   * the server, which resumes the graph. Reuses the SAME accumulator and the
   * SAME streaming assistant message — the resumed turn continues the
   * timeline rather than starting a fresh bubble, so the cause/effect chain
   * (reasoning → tool → ask → answer → continue) stays readable.
   *
   * `meta.approveForSession` (tool_approval only) adds the tool to the
   * session allowlist so future interrupts auto-approve.
   */
  const resolve = useCallback(
    async (body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => {
      if (!activeThreadId) return;
      // Update the session allowlist BEFORE clearing `ask` so the fast-path
      // check in doStream sees the new entry on the next interrupt.
      if (meta?.approveForSession && body.kind === "tool_approval") {
        const sources = (ask?.questions ?? [])
          .map((q) => q.context?.source)
          .filter((s): s is string => !!s);
        if (sources.length > 0) {
          setSessionAllowlist((prev) => {
            const next = new Set(prev);
            sources.forEach((s) => next.add(s));
            // Keep the ref in sync immediately so doStream's fast-path sees
            // the new entry on the very next interrupt (setState is async).
            sessionAllowlistRef.current = next;
            return next;
          });
        }
      }
      // Mark the timeline's AskEvent as resolved so its row collapses to an
      // outcome summary, then dismiss the input-area AskPanel.
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
      // busy stays true — the resumed stream keeps it that way. Don't append
      // a new assistant message; the existing streaming bubble continues.
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
  // Keep resolveRef pointed at the latest resolve on every render so doStream
  // (which can't list resolve in its deps without a cycle) always calls the
  // current closure. Assigning during render is safe here — it's a ref, not
  // state, and React guarantees render runs to completion before effects.
  resolveRef.current = resolve;

  /** Stop the in-flight generation (user clicked the pause button). */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Mark the streaming assistant bubble as done so the "正在生成回复..."
    // placeholder clears; the server will have persisted partial output.
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

  /** Attachment picker — records file names client-side only this iteration. */
  const pickAttachments = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const names = Array.from(files).map((f) => f.name);
    setAttachments((prev) => [...prev, ...names]);
    e.target.value = "";
  }, []);

  const doSend = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    send(t);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); return; }
    // Shift+Tab cycles access modes in place (plan -> confirm -> auto -> plan),
    // mirroring Claude Code's mode-switch shortcut. Keep focus in the textarea.
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const i = MODE_ORDER.indexOf(accessMode);
      setAccessMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
    }
  };

  const showStart = msgs.length === 0;

  const ppStyle: React.CSSProperties = {
    padding: "4px 8px", cursor: "pointer", fontSize: 13, borderRadius: 4,
    transition: "background-color 0.15s ease",
  };
  const iconBtnStyle: React.CSSProperties = {
    height: 28, borderRadius: 8, flexShrink: 0,
    color: "var(--gray-600)", transition: "color 0.2s ease",
    display: "flex", alignItems: "center",
  };

  // Build grouped model options: one "默认" entry + a group per provider.
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

  // Hidden file inputs (rendered once, triggered programmatically).
  const hiddenInputs = (
    <>
      <input
        ref={attachInputRef} type="file" multiple style={{ display: "none" }}
        onChange={pickAttachments}
      />
    </>
  );

  // Shared input bar: taller textarea on top, single bottom toolbar row.
  const inputBar = (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--gray-0)",
      border: `1px solid ${ACCESS_MODES[accessMode].borderColor}`,
      borderRadius: 13, padding: "10px 10px 8px",
      boxShadow: "0 2px 8px var(--shadow-1)",
      transition: "box-shadow 0.3s ease, border-color 0.3s ease",
    }}>
      {/* High-privilege banner: surfaces the risk whenever auto mode is armed
          so the user knows file changes will apply without per-step approval. */}
      {accessMode === "auto" && !busy && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 12, color: "var(--main-color)",
          padding: "2px 6px", marginBottom: 6,
          background: "var(--main-50)", borderRadius: 6,
        }}>
          <ThunderboltOutlined /> 自动模式：将直接执行文件变更，不再逐步确认
        </div>
      )}

      {/* Attachment chips (if any) */}
      {attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {attachments.map((name, i) => (
            <Tag
              key={i} closable onClose={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              style={{ marginInlineEnd: 0 }}
            >
              <PaperClipOutlined style={{ marginRight: 4 }} />
              {name}
            </Tag>
          ))}
        </div>
      )}

      {/* Textarea (taller) */}
      <TextArea
        value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={ACCESS_MODES[accessMode].placeholder}
        autoSize={showStart ? { minRows: 3, maxRows: 8 } : { minRows: 2, maxRows: 8 }}
        disabled={busy}
        variant="borderless"
        style={{
          flex: 1, resize: "none", fontSize: 15, fontFamily: "inherit",
          lineHeight: 1.5, padding: "2px 4px", background: "transparent",
        }}
        autoFocus
      />

      {/* Bottom toolbar row — all controls live here, send button rightmost */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        marginTop: 8, flexShrink: 0,
      }}>
        {/* Left group: + attachments, workspace (start-only), access mode */}
        <Popover
          placement="topLeft"
          trigger="click"
          overlayStyle={{ padding: 4 }}
          content={
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div
                style={{ ...ppStyle, display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => attachInputRef.current?.click()}
              >
                <FileAddOutlined /> 添加文件
              </div>
              <div
                style={{ ...ppStyle, display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => attachInputRef.current?.click()}
              >
                <PictureOutlined /> 上传图片
              </div>
            </div>
          }
        >
          <Button type="text" size="small"
            icon={<PlusOutlined />}
            style={{ ...iconBtnStyle }}
            className="hover-green"
          />
        </Popover>

        {/* Access mode — icon in the trigger, two-line (name + hint) options,
            Shift+Tab hint in the tooltip. */}
        <Tooltip title="Shift+Tab 切换模式" mouseEnterDelay={0.8}>
          <Select<AccessMode>
            size="small" variant="borderless"
            value={accessMode}
            onChange={(v) => setAccessMode(v)}
            style={{ minWidth: 110, fontSize: 12 }}
            popupMatchSelectWidth={false}
            labelRender={(p) => {
              const m = ACCESS_MODES[p.value as AccessMode];
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: m.dangerous ? "var(--main-color)" : "var(--gray-600)" }}>
                    {m.icon}
                  </span>
                  {m.label}
                </span>
              );
            }}
            optionRender={(opt) => {
              const m = ACCESS_MODES[opt.value as AccessMode];
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                  <span style={{ color: m.dangerous ? "var(--main-color)" : "var(--gray-600)" }}>
                    {m.icon}
                  </span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: 13 }}>{m.label}</span>
                    <span style={{ fontSize: 11, color: "var(--gray-600)" }}>{m.hint}</span>
                  </div>
                </div>
              );
            }}
            options={MODE_ORDER.map((m) => ({ value: m, label: ACCESS_MODES[m].label }))}
          />
        </Tooltip>

        {/* Spacer pushes the right group to the end */}
        <div style={{ flex: 1 }} />

        {/* Right group: model + send */}
        <Select
          size="small" variant="borderless"
          value={selectedModel ?? "__default__"}
          onChange={(v) => setSelectedModel(v === "__default__" ? null : v)}
          style={{ width: 150, fontSize: 12 }}
          popupMatchSelectWidth={false}
          options={[
            { label: "默认模型", value: "__default__" },
            ...modelOptions,
          ]}
        />

        <Tooltip title={busy ? "停止回答" : ""}>
          <Button
            type="text" shape="circle"
            icon={busy ? <PauseOutlined /> : <ArrowUpOutlined />}
            onClick={busy ? stop : doSend}
            disabled={!text.trim() && !busy}
            style={{
              width: 32, height: 32, flexShrink: 0, border: "none",
              background: "var(--main-500)", color: "var(--gray-0)",
              boxShadow: "0 2px 6px var(--shadow-2)",
              transition: "all 0.2s ease",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--main-color)";
              e.currentTarget.style.color = "var(--gray-0)";
              e.currentTarget.style.boxShadow = "0 4px 8px var(--shadow-3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--main-500)";
              e.currentTarget.style.color = "var(--gray-0)";
              e.currentTarget.style.boxShadow = "0 2px 6px var(--shadow-2)";
            }}
          />
        </Tooltip>
      </div>
      {hiddenInputs}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* Header */}
      <div style={{
        height: 45, display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", borderBottom: "1px solid var(--gray-150)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: "var(--gray-1000)" }}>
            {showStart ? "新对话" : "对话"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {/* Workspace drawer toggle — opens/collapses the workspace drawer.
              Bound to the current working directory (active or start-screen workspace). */}
          {activeWorkspace && (
            <Tooltip
              title={
                <div style={{ lineHeight: 1.6 }}>
                  <div>{fileTreeCollapsed ? "展开工作区浏览区" : "收起工作区浏览区"}</div>
                  <div style={{ fontSize: 11, opacity: 0.85, wordBreak: "break-all" }}>
                    {activeWorkspace.path}
                  </div>
                </div>
              }
            >
              <Button
                type={fileTreeCollapsed ? "text" : "primary"}
                size="small"
                onClick={() => setFileTreeCollapsed((v) => !v)}
                style={{
                  height: 28, borderRadius: 6, padding: "0 8px",
                  fontSize: 12, flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 4,
                }}
                className="hover-green"
              >
                {activeWorkspace.environment === "sandbox"
                  ? <CloudServerOutlined style={{ fontSize: 15 }} />
                  : <DesktopOutlined style={{ fontSize: 15 }} />}
                <span style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {activeWorkspace.name}
                </span>
                {activeWorkspace.environment === "sandbox" && (
                  <span style={{ fontSize: 11, opacity: 0.7 }}>未连接</span>
                )}
              </Button>
            </Tooltip>
          )}
          <Tooltip title="GitHub 仓库">
            <a
              href="https://github.com/kyrioscraft/octopus"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, borderRadius: 6,
                color: "var(--gray-600)", transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--main-color)";
                e.currentTarget.style.background = "var(--main-20)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--gray-600)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <GithubOutlined style={{ fontSize: 16 }} />
            </a>
          </Tooltip>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {showStart ? (
          /* ===== START SCREEN ===== */
          <div style={{
            position: "absolute", top: "45%", left: "50%",
            transform: "translate(-50%, -50%)",
            maxWidth: 800, width: "90%", textAlign: "center",
          }}>
            <div style={{ animation: "fadeInUp 0.4s ease-out" }}>
            <img
              src="/octopus-logo.svg"
              alt="Octopus"
              style={{
                width: 72, height: 72, marginBottom: 20,
                filter: "drop-shadow(0 4px 12px rgba(35,120,4,0.12))",
              }}
            />
            <h1 style={{
              fontSize: "1.4rem", fontWeight: 600, color: "var(--gray-1000)",
              marginBottom: 32, lineHeight: 1.4,
            }}>
              {greeting}
            </h1>
            {ask ? (
              <AskPanel payload={ask} onResolve={resolve} sessionAllowlist={sessionAllowlist} />
            ) : (
              inputBar
            )}
            <div style={{
              display: "flex", gap: 8, flexWrap: "wrap",
              justifyContent: "center", marginTop: 16,
            }}>
              {exampleQuestions.map((q, i) => (
                <div
                  key={i}
                  onClick={() => send(q)}
                  style={{
                    padding: "6px 12px", background: "var(--gray-25)",
                    borderRadius: 16, cursor: "pointer",
                    fontSize: "0.8rem", color: "var(--gray-700)",
                    whiteSpace: "nowrap", border: "1px solid transparent",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--main-200)";
                    e.currentTarget.style.color = "var(--main-700)";
                    e.currentTarget.style.boxShadow = "0 0 4px rgba(0,0,0,0.03)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "transparent";
                    e.currentTarget.style.color = "var(--gray-700)";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  {q}
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <span style={{ fontSize: 12, color: "var(--gray-300)" }}>
                Octopus Agent · 请注意辨别内容的可靠性
              </span>
            </div>
            </div>
          </div>
        ) : (
          /* ===== MESSAGES ===== */
          <div style={{ padding: "1rem 1.5rem" }}>
            <div style={{ maxWidth: 800, margin: "0 auto" }}>
              {msgs.map((m) => (
                <div key={m.id} style={{
                  display: "flex", flexDirection: "column",
                  alignItems: m.role === "user" ? "flex-end" : "flex-start",
                  marginBottom: 20, position: "relative",
                  animation: "fadeInUp 0.3s ease-out",
                }}>
                  {/* Reasoning + reply + tool calls.
                      For assistant turns we now render an ordered event
                      timeline (TurnTimeline) that preserves real execution
                      order (reasoning → tool → reasoning → tool → reply)
                      instead of the old type-grouped stacking. User messages
                      keep the simple bubble. The timeline itself handles
                      progressive disclosure (long finished turns collapse
                      their head) and per-type visual weight. */}
                  {m.role === "assistant" && m.events && m.events.length > 0 ? (
                    <TurnTimeline
                      events={m.events}
                      isActive={m.status === "streaming"}
                    />
                  ) : (
                    /* Fallback bubble for user messages, or assistant turns
                       that predate the events model (empty timeline). */
                    <div style={{
                      maxWidth: "95%",
                      padding: m.role === "user" ? "0.5rem 1rem" : "0",
                      borderRadius: m.role === "user" ? "0.5rem" : 0,
                      fontSize: 15, lineHeight: "24px", letterSpacing: "0.25px",
                      wordBreak: "break-word",
                      ...(m.role === "user"
                        ? {
                            whiteSpace: "pre-wrap",
                            background: "var(--main-50)",
                            color: "var(--gray-1000)",
                          }
                        : { color: "var(--gray-900)" }),
                    }}>
                      {m.role === "user" ? (
                        m.content
                      ) : m.content ? (
                        <Markdown content={m.content} />
                      ) : m.status === "streaming" ? (
                        <span style={{
                          background: "linear-gradient(90deg, var(--gray-700) 0%, var(--gray-700) 40%, var(--gray-300) 45%, var(--gray-200) 50%, var(--gray-300) 55%, var(--gray-700) 60%, var(--gray-700) 100%)",
                          backgroundSize: "200% auto",
                          WebkitBackgroundClip: "text",
                          backgroundClip: "text",
                          color: "transparent",
                          animation: "waveFlash 2s linear infinite",
                          fontSize: 14, fontWeight: 500, letterSpacing: "0.025em",
                        }}>
                          正在生成回复...
                        </span>
                      ) : ""}
                    </div>
                  )}

                  {/* Error hint */}
                  {m.error && (
                    <div style={{
                      background: "var(--color-error-50)",
                      border: "1px solid color-mix(in srgb, var(--color-error-500) 25%, transparent)",
                      borderRadius: 8, padding: "6px 12px", fontSize: 13,
                      color: "var(--color-error-500)", marginTop: 4,
                      width: "100%",
                    }}>
                      {m.error}
                    </div>
                  )}
                </div>
              ))}
              {/* Generating indicator when AI is busy but has no content yet */}
              {busy && msgs.length > 0 && msgs[msgs.length - 1]?.role !== "assistant" && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "0.5rem 0", animation: "fadeInUp 0.4s ease-out",
                }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%",
                    border: "2px solid var(--gray-200)",
                    borderTopColor: "var(--main-color)",
                    animation: "spin 0.8s linear infinite",
                  }} />
                  <span style={{
                    fontSize: 14, fontWeight: 500, letterSpacing: "0.025em",
                    background: "linear-gradient(90deg, var(--gray-700) 0%, var(--gray-700) 40%, var(--gray-300) 45%, var(--gray-200) 50%, var(--gray-300) 55%, var(--gray-700) 60%, var(--gray-700) 100%)",
                    backgroundSize: "200% auto",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                    animation: "waveFlash 2s linear infinite",
                  }}>
                    正在生成回复...
                  </span>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>
        )}
      </div>

      {/* Bottom input bar (only when messages exist) */}
      {!showStart && (
        <div style={{
          borderTop: "1px solid var(--gray-150)", padding: "12px 20px",
          background: "var(--gray-0)", flexShrink: 0,
        }}>
          <div style={{ maxWidth: 800, margin: "0 auto" }}>
            {ask ? (
              <AskPanel payload={ask} onResolve={resolve} sessionAllowlist={sessionAllowlist} />
            ) : (
              inputBar
            )}
            <div style={{ padding: "4px 0 0 4px" }}>
              <span style={{ fontSize: 12, color: "var(--gray-300)" }}>
                当前智能体：ChatbotAgent · 请注意辨别内容的可靠性
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Per-chat config drawer removed — global settings now live at /settings/* */}

      {/* HITL ask_user_question_required is rendered inline in the input-area
          slot above (AskPanel replaces inputBar while `ask` is non-null). */}
    </div>
  );
}
