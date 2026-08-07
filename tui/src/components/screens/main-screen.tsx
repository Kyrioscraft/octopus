// =============================================================================
// MainScreen — the primary application layout rendered when the server is
// connected. Composes the welcome screen, message list, chrome region
// (loading, approval, modals), input area, and status bar.
// =============================================================================

import React from "react";
import { Box } from "ink";
import type { AppPhase, InputMode, ChatMessageData, SessionStats, SpinnerStatus, SessionState } from "../../types.js";
import type { MergedCommand } from "../../command-registry.js";
import type { ModelEntry } from "../model-selector.js";
import type { McpServerEntry } from "../mcp-viewer.js";
import type { ApprovalRequest, ApprovalResult } from "../approval.js";
import { TuiClient } from "../../client/client.js";
import { MessageList, ChatRenderer } from "../messages.js";
import { ChatInput } from "../chat-input.js";
import { WelcomeScreen } from "../welcome.js";
import { StatusBar } from "../status-bar.js";
import { ApprovalMenu } from "../approval.js";
import { ModalRenderer } from "../modals/modal-renderer.js";

// =============================================================================
// Props
// =============================================================================

export interface MainScreenProps {
  // --- Connection ---
  phase: AppPhase;
  effectiveModel: string | null;
  serverUrl: string;

  // --- Chat ---
  messages: ChatMessageData[];
  showTimestamps: boolean;
  currentThreadId: string | null;
  inputMode: InputMode;
  spinnerStatus: SpinnerStatus;
  agentCwd: string | null;

  // --- Chat callbacks ---
  onModeChange: (mode: InputMode) => void;
  onSubmit: (text: string, mode: InputMode) => void;
  onThreadSelect: (threadId: string) => Promise<void>;

  // --- Modals ---
  activeModal: string | null;
  onCloseModal: () => void;
  clientRef: React.MutableRefObject<TuiClient | null>;
  // Modal data
  modalModels: ModelEntry[];
  modalAgents: { name: string; description: string }[];
  modalMcpServers: McpServerEntry[];
  modalLoading: boolean;
  loadModalModels: () => Promise<void>;
  loadModalAgents: () => Promise<void>;
  loadModalMcp: () => Promise<void>;
  // Modal callbacks
  onModalModelSelect: (spec: string) => void;
  onModalAgentSelect: (name: string) => void;
  onModalThemeSelect: (theme: string) => void;
  onModalAuthDismiss: () => void;

  // --- Approval ---
  pendingApproval: { requests: ApprovalRequest[] } | null;
  onApprovalDecide: (result: ApprovalResult) => Promise<void>;
  autoApprove: boolean;

  // --- Commands ---
  skills: { name: string; description: string }[];
  mergedCommands: MergedCommand[];

  // --- Status bar ---
  sessionStats: SessionStats;

  // --- Columns (from useWindowSize) ---
  columns: number;

  // --- Agent ---
  agentName: string;

  // --- Block-level rendering (new per tui-solution.md) ---
  /** Block-based session state for the ChatRenderer. */
  sessionState?: SessionState;
  /** Whether to use the new block-level rendering (default: false). */
  useBlockRendering?: boolean;
  /** Called when a confirm block is answered by the user (y/n). */
  onConfirmAnswer?: (approved: boolean) => void;
}

// =============================================================================
// Component
// =============================================================================

export const MainScreen: React.FC<MainScreenProps> = (props) => {
  const {
    phase, effectiveModel, serverUrl,
    messages, showTimestamps, currentThreadId,
    inputMode, spinnerStatus, agentCwd,
    onModeChange, onSubmit, onThreadSelect,
    activeModal, onCloseModal,
    clientRef,
    modalModels, modalAgents, modalMcpServers, modalLoading,
    loadModalModels, loadModalAgents, loadModalMcp,
    onModalModelSelect, onModalAgentSelect, onModalThemeSelect,
    onModalAuthDismiss,
    pendingApproval, onApprovalDecide, autoApprove,
    skills, mergedCommands,
    sessionStats, columns, agentName,
    sessionState, useBlockRendering, onConfirmAnswer,
  } = props;

  const hasContent = useBlockRendering
    ? (sessionState?.turns.length ?? 0) > 0
    : messages.length > 0;

  return (
    <Box flexDirection="column">
      {/* Welcome screen — shown when idle with no messages */}
      {!hasContent && phase === "ready" && (
        <WelcomeScreen
          model={effectiveModel}
          agentName={agentName}
          serverUrl={serverUrl}
          columns={columns}
        />
      )}

      {/* Block-level renderer (new) or Message list (legacy) */}
      {useBlockRendering && sessionState ? (
        <ChatRenderer
          session={sessionState}
          onConfirmAnswer={onConfirmAnswer}
        />
      ) : (
        <MessageList messages={messages} showTimestamps={showTimestamps} />
      )}

      {/* Chrome region — dynamic chrome (approval, modals) */}
      <Box flexDirection="column" flexShrink={0}>
        {/* HITL approval menu */}
        {pendingApproval && (
          <ApprovalMenu
            requests={pendingApproval.requests}
            onDecide={onApprovalDecide}
            autoApprove={autoApprove}
          />
        )}

        {/* Modal overlays */}
        <ModalRenderer
          activeModal={activeModal}
          onClose={onCloseModal}
          clientRef={clientRef}
          currentThreadId={currentThreadId}
          onThreadSelect={onThreadSelect}
          effectiveModel={effectiveModel}
          modalModels={modalModels}
          modalAgents={modalAgents}
          modalMcpServers={modalMcpServers}
          modalLoading={modalLoading}
          loadModalModels={loadModalModels}
          loadModalAgents={loadModalAgents}
          loadModalMcp={loadModalMcp}
          onModelSelect={onModalModelSelect}
          onAgentSelect={onModalAgentSelect}
          onThemeSelect={onModalThemeSelect}
          onAuthDismiss={onModalAuthDismiss}
          agentName={agentName}
        />
      </Box>

      {/* Input area — hidden during streaming to prevent layout jitter */}
      {phase !== "running" && (
        <Box flexShrink={0} flexDirection="column">
          <ChatInput
            inputMode={inputMode}
            phase={phase}
            onModeChange={onModeChange}
            onSubmit={(text, mode) => onSubmit(text, mode)}
            skills={skills}
            commands={mergedCommands}
          />
        </Box>
      )}

      {/* Status bar — hidden during streaming */}
      {phase !== "running" && (
        <Box flexShrink={0}>
          <StatusBar
            model={effectiveModel}
            threadId={currentThreadId}
            phase={phase}
            spinner={spinnerStatus}
            stats={sessionStats}
            cwd={agentCwd}
            inputMode={inputMode}
            autoApprove={autoApprove}
          />
        </Box>
      )}
    </Box>
  );
};
