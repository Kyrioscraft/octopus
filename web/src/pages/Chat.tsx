import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { OctopusClient } from "@octopus/tentacle";
import { useChatStore } from "../stores/chat.js";
import { useChat } from "../hooks/useChat.js";
import { AskPanel } from "../components/chat/input/AskPanel.js";
import { Companion, CompanionDivider } from "../components/chat/companion/index.js";
import { ChatHeader } from "../components/chat/ChatHeader.js";
import { StartScreen } from "../components/chat/input/StartScreen.js";
import { MessageList } from "../components/chat/messages/MessageList.js";
import { InputBar } from "../components/chat/input/InputBar.js";
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
  const {
    threads, activeThreadId, setActiveThreadId, setThreads,
    activeWorkspaceId,
    companionOpen, setCompanionOpen, openCompanionTab, companionTabs,
  } = useChatStore();

  const endRef = useRef<HTMLDivElement>(null);

  const listThreads = useCallback(async () => {
    const scope = activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined;
    try { setThreads(await sdk.listThreads(scope)); } catch { /* */ }
  }, [setThreads, activeWorkspaceId]);

  // The active workspace comes from the store (selected in the sidebar). New
  // conversations are bound to it; existing threads keep their own binding.
  const threadWorkspaceId = useMemo(
    () => threads.find((t) => t.id === activeThreadId)?.workspaceId ?? null,
    [threads, activeThreadId],
  );
  const sendWorkspaceId = threadWorkspaceId ?? activeWorkspaceId;

  const [greeting] = useState(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);

  const chat = useChat({
    activeThreadId,
    activeWorkspaceId,
    sendWorkspaceId,
    setActiveThreadId,
    listThreads,
    endRef,
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
  // cleared (new chat), clear messages so the start screen shows.
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (threadParam) {
      setActiveThreadId(threadParam);
      chat.load(threadParam);
    } else {
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
      attachInputRef={chat.attachInputRef}
      onPickAttachments={chat.pickAttachments}
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
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <ChatHeader
        showStart={chat.showStart}
        companionOpen={companionOpen}
        onToggleCompanion={toggleCompanion}
        todos={chat.todos}
        subagents={chat.allSubagents}
      />

      {/* Body — horizontal flex: the LEFT column (messages + input bar stacked)
          and the RIGHT column (companion panel) sit side by side below the header. */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
            {chat.showStart ? (
              <StartScreen
                greeting={greeting}
                inputArea={inputArea}
                onPickExample={(q) => chat.send(q)}
              />
            ) : (
              <MessageList
                msgs={chat.msgs}
                busy={chat.busy}
                endRef={endRef}
                onOpenSubagent={openSubagentPanel}
              />
            )}
          </div>

          {/* Bottom input bar (only when messages exist). Lives inside the LEFT
              column so its width shrinks with the message list when the
              companion panel opens. */}
          {!chat.showStart && (
            <div style={{
              padding: "12px 20px",
              background: "var(--gray-0)", flexShrink: 0,
            }}>
              <div style={{ maxWidth: 800, margin: "0 auto" }}>
                {inputArea}
                <div style={{ padding: "4px 0 0 4px" }}>
                  <span style={{ fontSize: 12, color: "var(--gray-300)" }}>
                    当前智能体：ChatbotAgent · 请注意辨别内容的可靠性
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        <CompanionDivider />

        <Companion subagents={chat.allSubagents} todos={chat.todos} />
      </div>
    </div>
  );
}
