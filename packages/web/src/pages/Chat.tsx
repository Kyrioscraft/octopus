import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Spin } from "antd";
import { useSearchParams } from "react-router-dom";
import { OctopusClient } from "@octopus/tentacle";
import { useChatStore } from "../stores/chat.js";
import { useChat } from "../hooks/useChat.js";
import { useStickToBottom } from "../hooks/useStickToBottom.js";
import { AskPanel } from "../components/chat/input/AskPanel.js";
import { ChatHeader } from "../components/chat/ChatHeader.js";
import { StartScreen } from "../components/chat/input/StartScreen.js";
import { MessageList } from "../components/chat/messages/MessageList.js";
import { InputBar } from "../components/chat/input/InputBar.js";
import { WorkspaceChipRow } from "../components/workspace/WorkspaceChipRow.js";
import { GREETINGS } from "../components/chat/constants.js";
import type { SubagentEvent } from "../components/chat/turn/types.js";

const sdk = new OctopusClient();

/**
 * ChatPage — the conversation page.
 *
 * This component is now a thin orchestration layer: it wires the zustand store
 * (threads, workspaces, companion panel) to the `useChat` hook (which owns ALL
 * conversation business logic — messages, streaming, send/resolve/stop, input
 * state, derived todos/subagents), and composes the UI components
 * (ChatHeader / StartScreen / MessageList / InputBar / Companion).
 *
 * The only logic kept here is the `?thread=` route-param effect (SPA navigation
 * between conversations) and the `threadWorkspaceId` derivation, since both
 * depend on the store's thread list + the router.
 */
export function ChatPage() {
  const [searchParams] = useSearchParams();
  // Selector-based subscriptions — a bare useChatStore() re-renders this whole
  // page on EVERY store change, including the per-token `companionMsgs` mirror
  // during streaming (a major crash driver on long runs).
  const threads = useChatStore((s) => s.threads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const setActiveThreadId = useChatStore((s) => s.setActiveThreadId);
  const setThreads = useChatStore((s) => s.setThreads);
  const activeWorkspaceId = useChatStore((s) => s.activeWorkspaceId);
  const companionOpen = useChatStore((s) => s.companionOpen);
  const setCompanionOpen = useChatStore((s) => s.setCompanionOpen);
  const openCompanionTab = useChatStore((s) => s.openCompanionTab);
  const companionTabs = useChatStore((s) => s.companionTabs);

  const endRef = useRef<HTMLDivElement>(null);
  const { scrollContainerRef, isStuck, scrollToBottom } = useStickToBottom();

  const listThreads = useCallback(async () => {
    // Same scoping as the sidebar: an active workspace lists its own threads;
    // no workspace lists ONLY unbound ones (never removed workspaces' history).
    const scope = activeWorkspaceId
      ? { workspaceId: activeWorkspaceId }
      : { workspaceId: "unbound" as const };
    try { setThreads(await sdk.listThreads(scope)); } catch { /* */ }
  }, [setThreads, activeWorkspaceId]);

  // The active workspace comes from the store (selected in the sidebar). New
  // conversations are bound to it; existing threads keep their own binding.
  const threadWorkspaceId = useMemo(
    () => threads.find((t) => t.id === activeThreadId)?.workspaceId ?? null,
    [threads, activeThreadId],
  );
  const sendWorkspaceId = threadWorkspaceId ?? activeWorkspaceId;

  // A brand-new task with no workspace selected puts the start screen's
  // composer into the dashed trigger state: input is gated until the user
  // picks one (existing threads are always already bound or explicitly
  // unbound, so the gate only applies to the fresh-chat view).
  const needsWorkspace = !activeThreadId && !activeWorkspaceId;

  // How the trigger state opens the picker. The chip row owns the menu, so the
  // composer card just forwards clicks to it via a custom window event — both
  // live in different subtrees and lifting the menu state here would couple
  // InputBar to the selector's internals.
  const openWorkspacePicker = useCallback(() => {
    window.dispatchEvent(new CustomEvent("octopus:open-workspace-picker"));
  }, []);

  const [greeting] = useState(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);

  const chat = useChat({
    activeThreadId,
    activeWorkspaceId,
    sendWorkspaceId,
    setActiveThreadId,
    listThreads,
    endRef,
    scrollToBottom,
  });

  // Toggle the companion panel. When opening with no tabs yet (no history of a
  // previously-open panel), default to the workspace files browser so the panel
  // isn't empty on first open.
  const toggleCompanion = useCallback(() => {
    if (!companionOpen && companionTabs.length === 0) {
      openCompanionTab("files");
    } else {
      setCompanionOpen((v) => !v);
    }
  }, [companionOpen, companionTabs, openCompanionTab, setCompanionOpen]);

  // React to `?thread=` query changes (SPA navigation between conversations).
  // On a fresh thread id, set it active + load its history; when the query is
  // cleared (new chat), clear messages so the start screen shows. The
  // lastLoadedRef guard skips a duplicate load of the SAME id (React
  // StrictMode runs effects twice on mount in dev — the second load() would
  // abort the first /events tail and silently stop live output).
  const threadParam = searchParams.get("thread");
  const lastLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (threadParam) {
      if (lastLoadedRef.current !== threadParam) {
        lastLoadedRef.current = threadParam;
        setActiveThreadId(threadParam);
        chat.load(threadParam);
      }
    } else {
      lastLoadedRef.current = null;
      setActiveThreadId(undefined);
      chat.clearMsgs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadParam]);

  /** Click handler for an inline subagent chip — opens a companion-panel tab. */
  const openSubagentPanel = useCallback(
    (ev: SubagentEvent) => {
      openCompanionTab("subagents", ev.id);
    },
    [openCompanionTab],
  );

  // The input-area slot: AskPanel when an interrupt is active, else InputBar.
  // Reused by both the start screen and the bottom input bar.
  const inputArea = chat.ask ? (
    <AskPanel payload={chat.ask} onResolve={chat.resolve} sessionAllowlist={chat.sessionAllowlist} />
  ) : (
    <InputBar
      text={chat.text}
      setText={chat.setText}
      busy={chat.busy}
      accessMode={chat.accessMode}
      setAccessMode={chat.setAccessMode}
      attachments={chat.attachments}
      onRemoveAttachment={chat.removeAttachment}
      onRetryAttachment={chat.retryAttachment}
      attachInputRef={chat.attachInputRef}
      onAddFiles={chat.addFiles}
      onKey={chat.onKey}
      selectedModel={chat.selectedModel}
      setSelectedModel={chat.setSelectedModel}
      modelOptions={chat.modelOptions}
      onSend={chat.doSend}
      onStop={chat.stop}
      showStart={chat.showStart}
      commands={chat.commands}
      onSlashSelect={chat.onSlashSelect}
      onSystemCommand={chat.handleSystemCommand}
      workspaceTrigger={chat.ask ? false : needsWorkspace}
      onWorkspaceTriggerClick={openWorkspacePicker}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <ChatHeader
        showStart={chat.showStart && !chat.loading}
        companionOpen={companionOpen}
        onToggleCompanion={toggleCompanion}
        todos={chat.todos}
        subagents={chat.allSubagents}
      />

      {/* Body — horizontal flex: the LEFT column (transcript + floating composer)
          and the RIGHT column (companion panel) sit side by side below the header. */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
          <div ref={scrollContainerRef} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", position: "relative" }}>
            {chat.loading ? (
              // Thread switch in flight — the list was optimistically blanked;
              // a centered spinner reads as "loading", not "empty conversation".
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Spin size="large" />
              </div>
            ) : chat.showStart ? (
              <StartScreen
                greeting={greeting}
                inputArea={inputArea}
                // Hero workspace selector (deepseek-harness style) — only on the
                // fresh-chat view; a bound thread needs no switcher.
                workspaceRow={
                  <WorkspaceChipRow pickerOpenEvent="octopus:open-workspace-picker" />
                }
                onPickExample={(q) => {
                  // Suggestion cards seed the composer with a prompt — sending
                  // one without a workspace would strand the thread unbound, so
                  // route the click to the picker instead.
                  if (needsWorkspace) openWorkspacePicker();
                  else chat.send(q);
                }}
              />
            ) : (
              <MessageList
                msgs={chat.msgs}
                busy={chat.busy}
                endRef={endRef}
                onOpenSubagent={openSubagentPanel}
                workspaceId={activeWorkspaceId}
              />
            )}

          </div>

          {/* Floating composer (only when messages exist). It overlays the bottom
              of the transcript — which fades out beneath it via the gradient —
              instead of occupying its own flex row. Absolute (rather than sticky)
              so messages genuinely scroll *under* the surface; MessageList adds
              the matching bottom inset so the last line can clear it. Lives
              inside the LEFT column so it shrinks with the transcript when the
              companion panel opens. */}
          {!chat.showStart && !chat.loading && (
            <div style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 5,
              padding: "0 24px 14px",
              background:
                "linear-gradient(to top, var(--bg-canvas) 72%, transparent 100%)",
              // Let clicks through the gradient's transparent region.
              pointerEvents: "none",
            }}>
              {/* "Back to bottom" pill — floats centered above the composer when
                  the user has scrolled up. zcode-style: a compact round icon
                  button on a solid elevated surface — noticeable, but quiet. */}
              {!isStuck && (
                <button
                  type="button"
                  className="focus-ring"
                  onClick={() => scrollToBottom({ force: true, smooth: true })}
                  aria-label="回到底部"
                  title="回到底部"
                  style={{
                    position: "absolute",
                    // Well above the composer's top edge — inside the clear gap
                    // between the last message line and the input box.
                    top: -48,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    boxShadow: "var(--shadow-lg)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    pointerEvents: "auto",
                    padding: 0,
                  }}
                >
                  {/* Inline down-arrow SVG (project uses custom SVG icons, not @ant-design/icons) */}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              )}
              <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", pointerEvents: "auto" }}>
                {inputArea}
                <div style={{ textAlign: "center", paddingTop: 7 }}>
                  <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-tertiary)" }}>
                    {activeWorkspaceId
                      ? "当前智能体：ChatbotAgent · 请注意辨别内容的可靠性"
                      : "未关联工作区 · 对话保存在「未关联」分组，文件类工具使用默认目录"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* The companion panel is NOT rendered here anymore — it is a layout-level
            sibling of the whole chat page (mounted in AppLayout, chat routes only),
            with its own header and the same slide animation as the left sidebar. */}
      </div>
    </div>
  );
}
