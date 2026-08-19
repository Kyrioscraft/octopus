// =============================================================================
// Message rendering — deepagents_code design language.
//
// Visual DNA:
//   - Left-border accent strips (borderStyle + only borderLeft) identify roles
//   - No speaker labels; color + glyph convey identity
//   - User:      blue left-border + "> " prefix
//   - Assistant: NO border, NO prefix — pure markdown
//   - Tool:      amber left-border + "⏺ tool_name(arg)" header + "⎿" output gutter
//   - Error:     pink left-border + "✗" prefix
//   - App:       no border, dim italic
//   - Skill:     purple left-border + "/ skill:name" header
// =============================================================================

import React from "react";
import { Box, Text, Static } from "ink";
import type { ChatMessageData, SessionState, AgentBlock } from "../types.js";
import { ExploreWidget } from "./explore-widget.js";
import { UserMessageView } from "./message-views/user-view.js";
import { AssistantMessageView } from "./message-views/assistant-view.js";
import { ToolCallMessageView } from "./message-views/tool-view.js";
import { ErrorMessageView } from "./message-views/error-view.js";
import { AppMessageView, SkillMessageView, SummarizationMessageView } from "./message-views/app-views.js";
import { DiffMessageView } from "./message-views/diff-view.js";
import { BlockView } from "./blocks/index.js";

// =============================================================================
// Static item wrapper for block rendering with turn context
// =============================================================================

type StaticItem =
  | { _type: "block"; block: AgentBlock; turnRole: "user" | "assistant" }
  | { _type: "separator" };

// =============================================================================
// Props
// =============================================================================

export interface MessageProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

// =============================================================================
// Dispatcher
// =============================================================================

const MessageImpl: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  switch (message.role) {
    case "user":
      return <UserMessageView message={message} showTimestamps={showTimestamps} />;
    case "assistant":
      return <AssistantMessageView message={message} showTimestamps={showTimestamps} />;
    case "tool":
      return <ToolCallMessageView message={message} showTimestamps={showTimestamps} />;
    case "error":
      return <ErrorMessageView message={message} showTimestamps={showTimestamps} />;
    case "app":
      return <AppMessageView message={message} showTimestamps={showTimestamps} />;
    case "skill":
      return <SkillMessageView message={message} showTimestamps={showTimestamps} />;
    case "summarization":
      return <SummarizationMessageView message={message} showTimestamps={showTimestamps} />;
    case "diff":
      return <DiffMessageView message={message} showTimestamps={showTimestamps} />;
    case "subagent":
      return <ExploreWidget message={message} showTimestamps={showTimestamps} />;
    default:
      return (
        <Box paddingLeft={1}>
          <Text>{message.content}</Text>
        </Box>
      );
  }
};

export const Message = React.memo(MessageImpl);

// =============================================================================
// Message list — <Static> + active region
//
// Ink's <Static> is append-only; once rendered, content stays on screen even
// when items are removed. We force a full re-render when messages shrink
// dramatically (e.g. /clear) by bumping a generation key.
// =============================================================================

export interface MessageListProps {
  messages: ChatMessageData[];
  showTimestamps?: boolean;
}

function isFinalized(msg: ChatMessageData): boolean {
  if (msg.role === "assistant") {
    return msg.metadata?.finalized === true;
  }
  if (msg.role === "tool") {
    const status = msg.metadata?.toolStatus as string | undefined;
    if (status === "running" || status === "awaiting_approval" || status === "pending") {
      return false;
    }
    return true;
  }
  if (msg.role === "subagent") {
    if (msg.metadata?.status === "running") return false;
    return true;
  }
  return true;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  showTimestamps,
}) => {
  // Force <Static> to fully re-render when messages shrink (e.g. /clear).
  // Ink's Static is append-only — items removed from the array don't erase
  // rendered output. Bumping the generation key on shrink forces a fresh render.
  const prevLenRef = React.useRef(messages.length);
  const genRef = React.useRef(0);
  if (messages.length < prevLenRef.current && messages.length <= 1) {
    genRef.current++;
  }
  prevLenRef.current = messages.length;
  const staticKey = `static-gen-${genRef.current}`;

  let splitIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isFinalized(messages[i]!)) {
      splitIdx = i + 1;
      break;
    }
    splitIdx = i;
  }

  const staticMessages = messages.slice(0, splitIdx);
  const activeMessages = messages.slice(splitIdx);

  return (
    <>
      <Static key={staticKey} items={staticMessages}>
        {(msg) => (
          <Message key={msg.id} message={msg} showTimestamps={showTimestamps} />
        )}
      </Static>
      {activeMessages.length > 0 && (
        <Box flexDirection="column">
          {activeMessages.map((msg) => (
            <Message key={msg.id} message={msg} showTimestamps={showTimestamps} />
          ))}
        </Box>
      )}
    </>
  );
};

// =============================================================================
// Block-level ChatRenderer — Static/Dynamic split at block granularity.
// Equivalent to ChatRenderer in architecture/tui-solution.md §4.
//
// Key insight: completed blocks are immediately frozen into <Static>,
// so only the currently-streaming block participates in React diff.
// This eliminates terminal flicker during streaming.
// =============================================================================

/**
 * Determine if a block has reached its final state and should be frozen.
 * Once frozen, the block goes into <Static> and never re-renders.
 */
function isBlockFrozen(block: AgentBlock): boolean {
  if (block.type === "confirm") {
    return block.status === "approved" || block.status === "rejected";
  }
  return block.status === "done";
}

export interface ChatRendererProps {
  /** The block-based session state. */
  session: SessionState;
  /** Callback when a confirm block is answered. */
  onConfirmAnswer?: (approved: boolean) => void;
}

/**
 * Block-level renderer that splits every turn into frozen (Static) and
 * active (Dynamic) blocks.
 *
 * - Finished turns: all blocks are frozen.
 * - Unfinished turn: completed blocks are frozen, active blocks stay dynamic.
 *
 * This guarantees that at most one block per turn is in the dynamic region,
 * making the per-frame diff O(1) regardless of total conversation length.
 */
export const ChatRenderer: React.FC<ChatRendererProps> = React.memo(({
  session,
  onConfirmAnswer,
}) => {
  // Collect frozen and active blocks with turn context
  const frozenItems: StaticItem[] = [];
  const active: Array<{ block: AgentBlock; turnRole: "user" | "assistant" }> = [];

  for (let ti = 0; ti < session.turns.length; ti++) {
    const turn = session.turns[ti]!;
    const isLastTurn = ti === session.turns.length - 1;

    // Add separator between turns (except before the first)
    if (ti > 0 && turn.role === "user") {
      frozenItems.push({ _type: "separator" });
    }

    if (!isLastTurn || turn.finished) {
      for (const block of turn.blocks) {
        frozenItems.push({ _type: "block", block, turnRole: turn.role });
      }
    } else {
      for (const block of turn.blocks) {
        if (isBlockFrozen(block)) {
          frozenItems.push({ _type: "block", block, turnRole: turn.role });
        } else {
          active.push({ block, turnRole: turn.role });
        }
      }
    }
  }

  // Force Static to re-render when turns are cleared
  const prevLenRef = React.useRef(session.turns.length);
  const genRef = React.useRef(0);
  if (session.turns.length < prevLenRef.current && session.turns.length <= 1) {
    genRef.current++;
  }
  prevLenRef.current = session.turns.length;
  const staticKey = `block-static-gen-${genRef.current}`;

  return (
    <>
      {/* Frozen zone: never re-renders, stays in terminal scrollback */}
      <Static key={staticKey} items={frozenItems}>
        {(item) => {
          if (item._type === "separator") {
            return <Text dimColor>{"─".repeat(40)}</Text>;
          }
          return (
            <BlockView
              key={item.block.id}
              block={item.block}
              showUserPrefix={item.turnRole === "user"}
            />
          );
        }}
      </Static>

      {/* Active zone: at most 1 block per turn — minimal diff */}
      {active.length > 0 && (
        <Box flexDirection="column">
          {active.map(({ block, turnRole }) => (
            <BlockView
              key={block.id}
              block={block}
              onConfirmAnswer={onConfirmAnswer}
              showUserPrefix={turnRole === "user"}
            />
          ))}
        </Box>
      )}
    </>
  );
});

ChatRenderer.displayName = "ChatRenderer";
