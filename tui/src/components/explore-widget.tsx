// =============================================================================
// ExploreWidget — expandable subagent activity view.
//
// Renders a `role: "subagent"` message. Shows the subagent's intent (task
// description) prominently, followed by the system prompt in a bordered
// section (auto-truncated if long), then a chronological list of the
// subagent's tool executions.
//
// Ink 5 does not support click handlers on Text. Unlike the web client there
// is no per-widget focus manager, so this widget renders fully expanded by
// default. The system prompt is auto-truncated to keep the output compact;
// long tool result summaries are also clipped.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import type { ChatMessageData } from "../types.js";
import type { SubagentActivityMeta, SubagentToolExec } from "../types.js";
import { getGlyphs } from "../config-ui.js";

export interface ExploreWidgetProps {
  message: ChatMessageData;
  showTimestamps?: boolean;
}

const MAX_PROMPT_LINES = 15;

export const ExploreWidget: React.FC<ExploreWidgetProps> = ({ message, showTimestamps }) => {
  const glyphs = getGlyphs();

  const meta = (message.metadata ?? {}) as Partial<SubagentActivityMeta>;
  const agentType = meta.agentType ?? "subagent";
  const description = meta.description ?? "";
  const systemPrompt = meta.systemPrompt;
  const status = meta.status ?? "running";
  const tools = meta.tools ?? [];

  const isRunning = status === "running";
  const statusIcon = isRunning ? glyphs.spinnerFrames[0] : glyphs.checkmark;
  const statusColor = isRunning ? "yellow" : "green";

  const toolCount = tools.length;
  const doneCount = tools.filter((t) => t.status === "done").length;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {/* Header */}
      <Box flexDirection="row">
        <Text color={statusColor} bold>
          {glyphs.bullet} Explore
        </Text>
        {agentType !== "main" && (
          <Text dimColor> ({agentType})</Text>
        )}
        {toolCount > 0 && (
          <Text dimColor> · {doneCount}/{toolCount} 个操作</Text>
        )}
        {isRunning && (
          <Text color="yellow"> {statusIcon}</Text>
        )}
        {showTimestamps && (
          <Text dimColor> · {new Date(message.timestamp).toLocaleTimeString()}</Text>
        )}
      </Box>

      {/* Intent (task description) */}
      {description && (
        <Box paddingLeft={2}>
          <Text italic color="cyan">{description}</Text>
        </Box>
      )}

      <Box flexDirection="column" paddingLeft={2} marginTop={0}>
        {/* System prompt (only shown when available, e.g. subagent scenario) */}
        {systemPrompt && (
          <Box marginBottom={1}>
            <SystemPromptSection prompt={systemPrompt} />
          </Box>
        )}

        {/* Tool executions */}
        {tools.length > 0 && (
          <Box flexDirection="column">
            {tools.map((tool, i) => (
              <ToolExecRow key={i} tool={tool} />
            ))}
          </Box>
        )}

        {tools.length === 0 && (
          <Box paddingLeft={2}>
            <Text dimColor>{isRunning ? "等待工具执行…" : "无工具调用"}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

// =============================================================================
// System prompt section — bordered, truncated if long
// =============================================================================

const SystemPromptSection: React.FC<{ prompt?: string }> = ({ prompt }) => {
  const glyphs = getGlyphs();
  if (!prompt) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>系统提示词不可用</Text>
      </Box>
    );
  }

  const lines = prompt.split("\n");
  const truncated = lines.length > MAX_PROMPT_LINES;
  const shown = truncated ? lines.slice(0, MAX_PROMPT_LINES) : lines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor bold>System Prompt</Text>
      {shown.map((line, i) => (
        <Text key={i} dimColor>{line || " "}</Text>
      ))}
      {truncated && (
        <Text dimColor>{glyphs.ellipsis} ({lines.length - MAX_PROMPT_LINES} more lines)</Text>
      )}
    </Box>
  );
};

// =============================================================================
// Single tool execution row
// =============================================================================

const ToolExecRow: React.FC<{ tool: SubagentToolExec }> = ({ tool }) => {
  const glyphs = getGlyphs();
  const icon = tool.status === "running"
    ? glyphs.spinnerFrames[0]
    : tool.status === "error"
    ? glyphs.cross
    : glyphs.checkmark;
  const color = tool.status === "running"
    ? "yellow"
    : tool.status === "error"
    ? "red"
    : "green";

  // Extract the most relevant argument for display (file path, command, url, query).
  const detail = formatToolDetail(tool.toolName, tool.args);
  const summary = tool.resultSummary ? ` · ${tool.resultSummary}` : "";

  return (
    <Box flexDirection="row">
      <Text color={color}>{icon} </Text>
      <Text bold color={color}>{tool.toolName}</Text>
      {detail && <Text> {detail}</Text>}
      {summary && <Text dimColor>{summary}</Text>}
    </Box>
  );
};

/** Format the most informative argument for a tool call. */
function formatToolDetail(toolName: string, args: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  if (name === "read_file" || name === "read") {
    return (args.file_path ?? args.path ?? "") as string;
  }
  if (name === "write_file" || name === "write") {
    return (args.file_path ?? args.path ?? "") as string;
  }
  if (name === "edit_file" || name === "edit") {
    return (args.file_path ?? args.path ?? "") as string;
  }
  if (name === "execute" || name === "shell" || name === "bash") {
    return (args.command ?? args.cmd ?? "") as string;
  }
  if (name.includes("search")) {
    return (args.query ?? args.url ?? "") as string;
  }
  if (name.includes("fetch")) {
    return (args.url ?? "") as string;
  }
  // Generic: show first string-valued arg.
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) return val.length > 60 ? val.slice(0, 60) + "…" : val;
  }
  return "";
}
