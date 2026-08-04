// =============================================================================
// ExploreWidget — subagent activity view with left-border accent strip.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessageData } from "../types.js";
import type { SubagentActivityMeta, SubagentToolExec } from "../types.js";
import { getGlyphs } from "../config-ui.js";
import { COLORS } from "../theme.js";
import { type DiffLine, buildDiffLines } from "./messages.js";

export interface ExploreWidgetProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

const MAX_PROMPT_LINES = 8;

export const ExploreWidget: React.FC<ExploreWidgetProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();
  const meta = (message.metadata ?? {}) as Partial<SubagentActivityMeta>;
  const agentType = meta.agentType ?? "subagent";
  const description = meta.description ?? "";
  const systemPrompt = meta.systemPrompt;
  const status = meta.status ?? "running";
  const tools = meta.tools ?? [];

  const isRunning = status === "running";
  const toolCount = tools.length;
  const doneCount = tools.filter((t) => t.status === "done").length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={COLORS.tool}
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      paddingLeft={1}
      marginBottom={1}
    >
      {/* Header: ⏺ Explore  N/M */}
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} </Text>
        <Text bold color={COLORS.tool}>
          {agentType === "subagent" || agentType === "main" ? "Explore" : agentType}
        </Text>
        {toolCount > 0 && <Text dimColor>  {doneCount}/{toolCount}</Text>}
        {isRunning && <Text color={COLORS.warning}> <Spinner type="dots" /></Text>}
        {showTimestamps && (
          <Text dimColor> {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>

      {/* Description — ⎿ gutter */}
      {description && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}><Text dimColor>{glyphs.branch}</Text></Box>
          <Text dimColor italic>{description}</Text>
        </Box>
      )}

      {/* System prompt — dim, truncated */}
      {systemPrompt && <SystemPromptSection prompt={systemPrompt} />}

      {/* Tool executions */}
      {tools.length > 0 && (
        <Box flexDirection="column">
          {tools.map((tool, i) => (
            <ToolExecRow key={i} tool={tool} />
          ))}
        </Box>
      )}

      {tools.length === 0 && isRunning && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}><Text dimColor>{glyphs.branch}</Text></Box>
          <Text dimColor>waiting for tool execution…</Text>
        </Box>
      )}
    </Box>
  );
};

// =============================================================================
// System prompt
// =============================================================================

const SystemPromptSection: React.FC<{ prompt?: string }> = ({ prompt }) => {
  const glyphs = getGlyphs();
  if (!prompt) return null;

  const lines = prompt.split("\n");
  const truncated = lines.length > MAX_PROMPT_LINES;
  const shown = truncated ? lines.slice(0, MAX_PROMPT_LINES) : lines;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}><Text dimColor>{glyphs.branch}</Text></Box>
        <Text dimColor>system prompt</Text>
      </Box>
      {shown.map((line, i) => (
        <Box key={i} flexDirection="row">
          <Box width={4} flexShrink={0}><Text dimColor> </Text></Box>
          <Text dimColor>{line || " "}</Text>
        </Box>
      ))}
      {truncated && (
        <Text dimColor>  {glyphs.ellipsis} {lines.length - MAX_PROMPT_LINES} more lines</Text>
      )}
    </Box>
  );
};

// =============================================================================
// Tool execution row — file edits show inline diff
// =============================================================================

const FILE_EDIT_NAMES = new Set(["write_file", "write", "edit_file", "edit"]);
const MAX_INLINE_DIFF = 8;

const ToolExecRow: React.FC<{ tool: SubagentToolExec }> = ({ tool }) => {
  const glyphs = getGlyphs();
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const isFileEdit = FILE_EDIT_NAMES.has(tool.toolName.toLowerCase());

  const statusColor = isRunning ? COLORS.warning : isError ? COLORS.error : COLORS.tool;

  const detail = formatToolDetail(tool.toolName, tool.args);
  const summary = tool.resultSummary || "";
  const diffStats = tool.diffStats;

  // Build diff lines for file-edit tools
  const diffLines: DiffLine[] = isFileEdit ? buildDiffLines(tool.toolName, tool.args as Record<string, unknown>) : [];
  const diffShown = diffLines.slice(0, MAX_INLINE_DIFF);

  return (
    <Box flexDirection="column">
      {/* Tool call line */}
      <Box flexDirection="row">
        <Text color={statusColor}>
          {isRunning ? <Spinner type="dots" /> : isError ? glyphs.cross : glyphs.toolCall}
        </Text>
        <Text bold color={statusColor}> {tool.toolName}</Text>
        {detail && <Text> {detail}</Text>}
        {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
          <Text>
            {"  "}
            <Text color={COLORS.success}>+{diffStats.added}</Text>
            {" "}
            <Text color={COLORS.error}>-{diffStats.removed}</Text>
          </Text>
        )}
      </Box>

      {/* Inline diff for file edits */}
      {diffShown.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {diffShown.map((line, i) => (
            <Text key={i} color={line.color}>{line.text}</Text>
          ))}
          {diffLines.length > MAX_INLINE_DIFF && (
            <Text dimColor>{glyphs.ellipsis} {diffLines.length - MAX_INLINE_DIFF} more lines</Text>
          )}
        </Box>
      )}

      {/* Result summary for non-file-edit tools */}
      {summary && !isFileEdit && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}><Text dimColor>{glyphs.branch}</Text></Box>
          <Text dimColor>{summary}</Text>
        </Box>
      )}
    </Box>
  );
};

// =============================================================================
// Format tool detail for inline display
// =============================================================================

function formatToolDetail(toolName: string, args: Record<string, unknown>): string {
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
      if (typeof v === "string" && v.length > 0) { val = v; break; }
    }
  }
  if (!val) return "";
  return val.length > 60 ? val.slice(0, 60) + "…" : val;
}
