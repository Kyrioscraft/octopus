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
import { Box, Text, Static, useStdout } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessageData, ToolStatus } from "../types.js";
import { getGlyphs } from "../config-ui.js";
import { ExploreWidget } from "./explore-widget.js";
import { Markdown } from "./markdown.js";
import { COLORS } from "../theme.js";

// =============================================================================
// Props
// =============================================================================

export interface MessageProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

// =============================================================================
// Left-border accent strip helper
// =============================================================================

/** A Box with only the left border rendered, in the given accent color. */
const LeftStrip: React.FC<{
  color: string;
  children: React.ReactNode;
}> = ({ color, children }) => (
  <Box
    flexDirection="column"
    borderStyle="single"
    borderColor={color}
    borderRight={false}
    borderTop={false}
    borderBottom={false}
    paddingLeft={1}
    marginBottom={1}
  >
    {children}
  </Box>
);

// =============================================================================
// Output gutter — fixed-width ⎿ column for hanging indent
// =============================================================================

const OutputGutter: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const glyphs = getGlyphs();
  return (
    <Box flexDirection="row" marginTop={0}>
      <Box width={2} flexShrink={0}>
        <Text dimColor>{glyphs.branch}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
};

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
// Timestamp
// =============================================================================

const Timestamp: React.FC<{ message: ChatMessageData }> = ({ message }) => (
  <Text dimColor> {new Date(message.timestamp).toLocaleTimeString()}</Text>
);

// =============================================================================
// User message — blue left-border + "> " prefix
// =============================================================================

const UserMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <LeftStrip color={COLORS.primary}>
      <Box flexDirection="row">
        <Text bold color={COLORS.primary}>{">"}</Text>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <Text>{message.content}</Text>
        </Box>
      </Box>
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// Assistant message — NO border, NO prefix, pure markdown
// =============================================================================

const AssistantMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const reasoning = message.metadata?.reasoning as string | undefined;
  const isFinalized = message.metadata?.finalized === true;
  const hasContent = message.content.length > 0;

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {/* Reasoning — multi-line dimmed block, truncated to 10 lines */}
      {reasoning && <ReasoningBlock reasoning={reasoning} />}

      {/* Content or loading placeholder */}
      {hasContent ? (
        <Box flexDirection="row">
          <Box flexDirection="column" flexGrow={1}>
            {/* Streaming: plain Text (no layout shifts). Finalized: full Markdown. */}
            {isFinalized ? (
              <Markdown>{message.content}</Markdown>
            ) : (
              <Text>{message.content}</Text>
            )}
          </Box>
          {/* Streaming cursor */}
          {!isFinalized && (
            <Text color={COLORS.primary}><Spinner type="dots" /></Text>
          )}
        </Box>
      ) : !isFinalized ? (
        <Text dimColor><Spinner type="dots" /> Thinking...</Text>
      ) : (
        <Text dimColor>(empty response)</Text>
      )}

      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};

// =============================================================================
// Reasoning block — dimmed italic multi-line display
// =============================================================================

const MAX_REASONING_LINES = 10;

const ReasoningBlock: React.FC<{ reasoning: string }> = ({ reasoning }) => {
  const glyphs = getGlyphs();
  const lines = reasoning.split("\n").filter((l) => l.trim().length > 0);
  const shown = lines.slice(0, MAX_REASONING_LINES);
  if (shown.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {shown.map((line, i) => (
        <Text key={i} dimColor italic>{glyphs.dashed} {line}</Text>
      ))}
      {lines.length > MAX_REASONING_LINES && (
        <Text dimColor>  {glyphs.ellipsis} {lines.length - MAX_REASONING_LINES} more lines</Text>
      )}
    </Box>
  );
};

// =============================================================================
// Tool call — amber left-border + ⏺ tool_name(primary_arg) + inline status + ⎿ output gutter
// =============================================================================

const FILE_EDIT_TOOLS = new Set(["write_file", "write", "edit_file", "edit"]);

function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.toLowerCase());
}

const ToolCallMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const toolName = (message.metadata?.toolName as string) ?? "tool";
  const toolStatus = (message.metadata?.toolStatus as ToolStatus) ?? "success";
  const toolArgs = message.metadata?.toolArgs as Record<string, unknown> | undefined;

  if (isFileEditTool(toolName)) {
    return <FileEditToolView message={message} showTimestamps={showTimestamps} />;
  }

  const glyphs = getGlyphs();

  const isRunning = toolStatus === "running";
  const isError = toolStatus === "error" || toolStatus === "rejected";
  const isWaiting = toolStatus === "awaiting_approval";

  // Primary arg for inline display
  const primaryArg = formatPrimaryArg(toolName, toolArgs, Math.max(20, cols - 10));

  // Result content
  const content = message.content || "";
  const contentLines = content.split("\n").filter((l) => l.trim().length > 0);
  const maxLines = 6;
  const truncatedContent = contentLines.length > maxLines
    ? contentLines.slice(0, maxLines).join("\n")
    : content;

  return (
    <LeftStrip color={COLORS.tool}>
      {/* Header: ⏺ tool_name(primary_arg)  status */}
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} </Text>
        <Text bold color={COLORS.tool}>{toolName}</Text>
        {primaryArg && <Text color={COLORS.tool}>{primaryArg}</Text>}
        <Text>  </Text>
        {isRunning && (
          <Text color={COLORS.warning}><Spinner type="dots" /> running</Text>
        )}
        {isError && (
          <Text color={COLORS.error}>{glyphs.cross} error</Text>
        )}
        {isWaiting && (
          <Text color={COLORS.warning}><Spinner type="dots" /> awaiting approval</Text>
        )}
        {!isRunning && !isError && !isWaiting && (
          <Text color={COLORS.success}>{glyphs.checkmark} done</Text>
        )}
      </Box>

      {/* Result content — ⎿ gutter, shown when not running */}
      {contentLines.length > 0 && !isRunning && (
        <Box flexDirection="row" marginTop={0}>
          <Box width={2} flexShrink={0}>
            <Text dimColor>{glyphs.branch}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {contentLines.slice(0, maxLines).map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
            {contentLines.length > maxLines && (
              <Text dimColor>{glyphs.ellipsis} {contentLines.length - maxLines} more lines</Text>
            )}
          </Box>
        </Box>
      )}

      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// File-edit tool — amber left-border + Git-style diff
// =============================================================================

const MAX_DIFF_LINES = 15;

const FileEditToolView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const toolName = (message.metadata?.toolName as string) ?? "edit_file";
  const toolStatus = (message.metadata?.toolStatus as string) ?? "done";
  const toolArgs = (message.metadata?.toolArgs ?? {}) as Record<string, unknown>;
  const diffStats = message.metadata?.diffStats as { added: number; removed: number } | undefined;

  const filePath = (toolArgs.file_path ?? toolArgs.path ?? "") as string;
  const isRunning = toolStatus === "running";
  const isError = toolStatus === "error" || toolStatus === "rejected";

  // Build diff lines
  const diffLines = buildDiffLines(toolName, toolArgs);
  const hasDiff = diffLines.length > 0;
  const shown = diffLines.slice(0, MAX_DIFF_LINES);

  return (
    <LeftStrip color={COLORS.tool}>
      {/* Header: ⏺ edit_file  path  +N -M  status */}
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} </Text>
        <Text bold color={COLORS.tool}>{toolName}</Text>
        {filePath && <Text> {filePath}</Text>}
        {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
          <Text>
            {"  "}
            <Text color={COLORS.success}>+{diffStats.added}</Text>
            {" "}
            <Text color={COLORS.error}>-{diffStats.removed}</Text>
          </Text>
        )}
        <Text>  </Text>
        {isRunning ? (
          <Text color={COLORS.warning}><Spinner type="dots" /> running</Text>
        ) : isError ? (
          <Text color={COLORS.error}>{glyphs.cross} error</Text>
        ) : (
          <Text color={COLORS.success}>{glyphs.checkmark} done</Text>
        )}
      </Box>

      {/* Diff content — ⎿ gutter */}
      {hasDiff && (
        <Box flexDirection="row" marginTop={0}>
          <Box width={2} flexShrink={0}>
            <Text dimColor>{glyphs.branch}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {shown.map((line, i) => (
              <Text key={i} color={line.color}>{line.text}</Text>
            ))}
            {diffLines.length > MAX_DIFF_LINES && (
              <Text dimColor>{glyphs.ellipsis} {diffLines.length - MAX_DIFF_LINES} more lines</Text>
            )}
          </Box>
        </Box>
      )}

      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// Diff line builder (shared with explore-widget)
// =============================================================================

export interface DiffLine {
  text: string;
  color: "red" | "green" | undefined;
}

export function buildDiffLines(toolName: string, args: Record<string, unknown>): DiffLine[] {
  const name = toolName.toLowerCase();
  const lines: DiffLine[] = [];

  if (name === "edit_file" || name === "edit") {
    const oldText = (args.old_text ?? args.old_string ?? "") as string;
    const newText = (args.new_text ?? args.new_string ?? "") as string;
    for (const line of (oldText ? oldText.split("\n") : [])) {
      lines.push({ text: `- ${line}`, color: "red" });
    }
    for (const line of (newText ? newText.split("\n") : [])) {
      lines.push({ text: `+ ${line}`, color: "green" });
    }
  } else if (name === "write_file" || name === "write") {
    const content = (args.content ?? "") as string;
    for (const line of (content ? content.split("\n") : [])) {
      lines.push({ text: `+ ${line}`, color: "green" });
    }
  }

  return lines;
}

// =============================================================================
// Tool arg formatting
// =============================================================================

/** Format the primary argument for inline display: (value). */
function formatPrimaryArg(
  toolName: string,
  args: Record<string, unknown> | undefined,
  maxLen: number,
): string {
  if (!args) return "";
  const name = toolName.toLowerCase();
  let val: string;

  if (name === "read_file" || name === "read" || name === "write_file" || name === "write" || name === "edit_file" || name === "edit") {
    val = (args.file_path ?? args.path ?? "") as string;
  } else if (name === "execute" || name === "shell" || name === "bash") {
    val = (args.command ?? args.cmd ?? "") as string;
  } else if (name.includes("search")) {
    val = (args.query ?? args.url ?? "") as string;
  } else if (name.includes("fetch")) {
    val = (args.url ?? "") as string;
  } else {
    val = "";
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.length > 0) {
        val = v;
        break;
      }
    }
  }

  if (!val) return "";
  const display = val.length > maxLen ? val.slice(0, maxLen) + "…" : val;
  return `(${display})`;
}

// =============================================================================
// Error — pink left-border + ✗
// =============================================================================

const ErrorMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  return (
    <LeftStrip color={COLORS.error}>
      <Box flexDirection="row">
        <Text bold color={COLORS.error}>{glyphs.cross}</Text>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <Text color={COLORS.error}>{message.content}</Text>
        </Box>
      </Box>
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// App / system — no border, dim italic
// =============================================================================

const AppMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <Box flexDirection="row" paddingLeft={1} marginBottom={1}>
      <Text dimColor italic>{message.content}</Text>
      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};

// =============================================================================
// Skill — purple left-border + / skill:name
// =============================================================================

const SkillMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const skillName = (message.metadata?.skillName as string) ?? "skill";
  return (
    <LeftStrip color={COLORS.skill}>
      <Box flexDirection="row">
        <Text bold color={COLORS.skill}>/ skill:{skillName}</Text>
      </Box>
      {message.content && (
        <OutputGutter>
          <Text dimColor>{message.content}</Text>
        </OutputGutter>
      )}
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// Summarization — no border, dim
// =============================================================================

const SummarizationMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  return (
    <Box flexDirection="row" paddingLeft={1} marginBottom={1}>
      <Text dimColor italic>{message.content}</Text>
      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};

// =============================================================================
// Diff — amber left-border
// =============================================================================

const DiffMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const lines = message.content.split("\n");
  const shown = lines.slice(0, 30);

  return (
    <LeftStrip color={COLORS.tool}>
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} Diff</Text>
      </Box>
      <OutputGutter>
        {shown.map((line, i) => {
          const color = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
          return <Text key={i} color={color}>{line}</Text>;
        })}
      </OutputGutter>
      {showTimestamps && <Timestamp message={message} />}
    </LeftStrip>
  );
};

// =============================================================================
// Message list — <Static> + active region
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
      <Static items={staticMessages}>
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
