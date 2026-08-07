// =============================================================================
// Tool call — amber left-border + ⏺ tool_name(primary_arg) + inline status + ⎿ output gutter
// =============================================================================

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { ToolStatus } from "../../types.js";
import type { MessageProps } from "./shared.js";
import { isFileEditTool, buildDiffLines } from "../../core/tool-utils.js";
import type { DiffLine } from "../../core/tool-utils.js";
import { getGlyphs } from "../../terminal/config-ui.js";
import { COLORS } from "../../terminal/theme.js";
import { Timestamp } from "./shared.js";
import { FileEditToolView } from "./file-edit-view.js";

export const ToolCallMessageView: React.FC<MessageProps> = ({ message, showTimestamps }) => {
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

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* ⏺ tool_name arg  ⠋ — single text line, no border */}
      <Box flexDirection="row">
        <Text bold color={COLORS.tool}>{glyphs.toolCall} </Text>
        <Text bold color={COLORS.tool}>{toolName}</Text>
        {primaryArg && <Text color={COLORS.tool}>{primaryArg}</Text>}
        {isRunning && (
          <Text color={COLORS.warning}>  ●</Text>
        )}
        {isError && (
          <Text color={COLORS.error}>  {glyphs.cross}</Text>
        )}
        {isWaiting && (
          <Text color={COLORS.warning}>  ●</Text>
        )}
        {!isRunning && !isError && !isWaiting && (
          <Text color={COLORS.success}>  {glyphs.checkmark}</Text>
        )}
      </Box>

      {showTimestamps && <Timestamp message={message} />}
    </Box>
  );
};

// =============================================================================
// Tool arg formatting
// =============================================================================

/** Format the primary argument for inline display: " path_or_arg". */
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
  // Show basename for file paths when truncated, full path otherwise
  if (val.length > maxLen) {
    const slash = val.lastIndexOf("/");
    const basename = slash >= 0 ? val.slice(slash + 1) : val;
    if (basename.length <= maxLen - 3) {
      return ` …/${basename}`;
    }
    return ` ${val.slice(0, maxLen - 1)}…`;
  }
  return ` ${val}`;
}
