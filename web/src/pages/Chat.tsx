import { useState, useCallback, useEffect, useRef } from "react";
import { Input, Button, Tooltip, Popover, Collapse } from "antd";
import {
  ArrowUpOutlined, RobotOutlined, PauseOutlined,
  PaperClipOutlined, CaretRightOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import { OctopusClient, type StreamEvent, type MessageRow } from "@octopus/tentacle";
import { useChatStore } from "../stores/chat.js";
import { useSearchParams } from "react-router-dom";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { AgentConfigSidebar } from "../components/AgentConfigSidebar.js";

const { TextArea } = Input;
const sdk = new OctopusClient();

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
  reasoning?: string;
  error?: string;
}

export function ChatPage() {
  const [searchParams] = useSearchParams();
  const { activeThreadId, setActiveThreadId, setThreads, configOpen, setConfigOpen } = useChatStore();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<any>(null);
  const [greeting] = useState(() => greetings[Math.floor(Math.random() * greetings.length)]);
  const endRef = useRef<HTMLDivElement>(null);
  // AbortController for the in-flight stream. Clicking the stop button
  // aborts it; the server sees the disconnect and persists partial output
  // (chat_service.py handles asyncio.CancelledError).
  const abortRef = useRef<AbortController | null>(null);

  const listThreads = useCallback(async () => {
    try { setThreads(await sdk.listThreads()); } catch { /* */ }
  }, [setThreads]);

  useEffect(() => {
    listThreads();
    const tid = searchParams.get("thread");
    if (tid) { setActiveThreadId(tid); load(tid); }
  }, []);

  const load = useCallback(async (tid: string) => {
    try {
      const r = await sdk.getThreadHistory(tid);
      setMsgs((r.history ?? []).map((m: MessageRow) => ({
        id: m.id, role: m.role as Msg["role"], content: m.content, status: "done",
      })));
    } catch { setMsgs([]); }
  }, []);

  const scroll = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  const consume = useCallback(async function* () {} as any, []);

  // Stream consumer — defined inline to capture closure state
  const doStream = useCallback(async (stream: AsyncGenerator<StreamEvent>, tid: string) => {
    try {
      for await (const ev of stream) {
        switch (ev.status) {
          case "init":
            if (!activeThreadId && ev.meta?.thread_id) {
              setActiveThreadId(ev.meta.thread_id as string);
              listThreads();
            }
            break;
          case "loading":
          case "reasoning":
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              const tok = typeof ev.response === "string" ? ev.response : "";
              const isReason = ev.status === "reasoning";
              if (last?.role === "assistant" && last?.status === "streaming") {
                c[c.length - 1] = {
                  ...last,
                  content: isReason ? last.content : last.content + tok,
                  reasoning: isReason ? (last.reasoning ?? "") + tok : last.reasoning,
                };
              }
              return c;
            });
            scroll();
            break;
          case "ask_user_question_required":
            setApproval({ questions: (ev.questions as any) ?? [{ question: "是否批准此操作?" }] });
            return;
          case "finished":
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") c[c.length - 1] = { ...last, status: "done" };
              return c;
            });
            listThreads();
            break;
          case "error":
            setMsgs((prev) => {
              const c = [...prev];
              const last = c[c.length - 1];
              if (last?.role === "assistant") {
                c[c.length - 1] = { ...last, status: "error", error: ev.error_message ?? "未知错误" };
              }
              return c;
            });
            break;
        }
      }
    } catch (err: any) {
      // AbortError is expected when the user clicks stop — leave the bubble
      // state as `stop()` set it.
      if (err?.name === "AbortError") return;
      setMsgs((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (last?.role === "assistant") {
          c[c.length - 1] = { ...last, status: "error", error: err?.message ?? "请求失败" };
        }
        return c;
      });
    } finally { setBusy(false); }
  }, [activeThreadId, listThreads, setActiveThreadId]);

  const send = useCallback(async (content: string) => {
    const u: Msg = { id: `u_${Date.now()}`, role: "user", content, status: "done" };
    const a: Msg = { id: `a_${Date.now()}`, role: "assistant", content: "", status: "streaming" };
    setMsgs((p) => [...p, u, a]);
    setBusy(true);
    setApproval(null);
    scroll();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const stream = await sdk.streamAgentChat(
        { messages: [{ role: "user", content }], thread_id: activeThreadId },
        { signal: controller.signal }
      );
      await doStream(stream, activeThreadId ?? "");
    } catch (err: any) {
      // AbortError is expected when the user clicks stop — don't surface it.
      if (err?.name !== "AbortError") setBusy(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeThreadId, doStream]);

  const resume = useCallback(async (approved: boolean) => {
    if (!activeThreadId) return;
    setApproval(null);
    const a: Msg = { id: `a_${Date.now()}`, role: "assistant", content: "", status: "streaming" };
    setMsgs((p) => [...p, a]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await doStream(
        await sdk.streamAgentResume(activeThreadId, approved, { signal: controller.signal }),
        activeThreadId
      );
    } catch (err: any) {
      if (err?.name !== "AbortError") setBusy(false);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [activeThreadId, doStream]);

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

  const doSend = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    send(t);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  const showStart = msgs.length === 0;

  const ppStyle: React.CSSProperties = {
    padding: "4px 8px", cursor: "pointer", fontSize: 13, borderRadius: 4,
    transition: "background-color 0.15s ease",
  };

  // Shared input bar component
  const inputBar = (
    <div style={{
      display: "flex", alignItems: "flex-end", gap: 8,
      background: "var(--gray-0)", border: "1px solid var(--gray-150)",
      borderRadius: 13, padding: "8px 8px 8px 12px",
      boxShadow: "0 2px 8px var(--shadow-1)",
      transition: "box-shadow 0.3s ease, border-color 0.3s ease",
    }}>
      <Popover
        placement="topLeft"
        trigger="click"
        overlayStyle={{ padding: 4 }}
        content={
          <div>
            <div style={ppStyle}>📎 添加附件</div>
            <div style={ppStyle}>🖼️ 上传图片</div>
          </div>
        }
      >
        <Button type="text" size="small"
          icon={<PaperClipOutlined style={{ transform: "rotate(-45deg)" }} />}
          style={{
            width: 28, height: 28, borderRadius: 8, flexShrink: 0,
            color: "var(--gray-600)", transition: "color 0.2s ease",
          }}
          className="hover-green"
        />
      </Popover>
      <TextArea
        value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="问点什么？使用 @ 可以提及哦~"
        autoSize={showStart ? { minRows: 2, maxRows: 6 } : { minRows: 1, maxRows: 6 }}
        disabled={busy}
        variant="borderless"
        style={{
          flex: 1, resize: "none", fontSize: 15, fontFamily: "inherit",
          lineHeight: 1.5, padding: 0, background: "transparent",
        }}
        autoFocus
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
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* Header */}
      <div style={{
        height: 45, display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", borderBottom: "1px solid var(--gray-150)", flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--gray-1000)" }}>
          {showStart ? "新对话" : "对话"}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {msgs.length > 0 && (
            <Tooltip title="文件">
              <Button type="text" size="small"
                icon={<FolderOpenOutlined />}
                style={{
                  width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)",
                  transition: "all 0.15s ease",
                }}
              />
            </Tooltip>
          )}
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
            <RobotOutlined style={{ fontSize: 48, color: "var(--main-500)", marginBottom: 16 }} />
            <h1 style={{
              fontSize: "1.4rem", fontWeight: 600, color: "var(--gray-1000)",
              marginBottom: 32, lineHeight: 1.4,
            }}>
              {greeting}
            </h1>
            {inputBar}
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
                  {/* Reasoning collapse */}
                  {m.reasoning && (
                    <Collapse
                      ghost size="small"
                      expandIcon={({ isActive }) =>
                        <CaretRightOutlined rotate={isActive ? 90 : 0}
                          style={{ fontSize: 12 }} />}
                      items={[{
                        key: "r",
                        label: (
                          <span style={{
                            fontSize: 13, fontWeight: 500,
                            color: "var(--gray-500)", letterSpacing: "0.025em",
                          }}>
                            {m.status === "streaming"
                              ? "正在思考..."
                              : "推理过程"}
                          </span>
                        ),
                        children: (
                          <div style={{
                            fontSize: 13, color: "var(--gray-500)",
                            fontStyle: "italic", lineHeight: 1.6,
                          }}>
                            {m.reasoning}
                          </div>
                        ),
                      }]}
                      style={{
                        background: "var(--gray-25)", borderRadius: 8,
                        border: "1px solid var(--gray-150)",
                        marginBottom: 8, width: "100%",
                      }}
                    />
                  )}

                  {/* Message bubble */}
                  <div style={{
                    maxWidth: "95%",
                    padding: m.role === "user" ? "0.5rem 1rem" : "0",
                    borderRadius: m.role === "user" ? "0.5rem" : 0,
                    fontSize: 15, lineHeight: "24px", letterSpacing: "0.25px",
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                    ...(m.role === "user"
                      ? { background: "var(--main-50)", color: "var(--gray-1000)" }
                      : { color: "var(--gray-900)" }),
                  }}>
                    {m.content || (
                      m.status === "streaming" ? (
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
                      ) : ""
                    )}
                  </div>

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
            {inputBar}
            <div style={{ padding: "4px 0 0 4px" }}>
              <span style={{ fontSize: 12, color: "var(--gray-300)" }}>
                当前智能体：ChatbotAgent · 请注意辨别内容的可靠性
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Right config panel */}
      <AgentConfigSidebar open={configOpen} onClose={() => setConfigOpen(false)} />

      {/* HITL Approval */}
      {approval && (
        <ApprovalDialog
          questions={approval.questions}
          onApprove={() => resume(true)}
          onReject={() => resume(false)}
        />
      )}
    </div>
  );
}
