// =============================================================================
// Tool-specific approval preview widgets.
// Equivalent to Python tui.widgets.tool_widgets.
//
// Each tool type gets a specialized widget that displays its arguments
// in a human-readable form for the HITL approval dialog.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import { getGlyphs } from "../terminal/config-ui.js";

// =============================================================================
// Rendered result
// =============================================================================

export interface RenderedToolPreview {
  /** Title line for the preview. */
  title?: string;
  /** Detail lines (stats, metadata). */
  details?: string[];
  /** Code content (file contents, script, etc.). */
  code?: string;
  /** Diff lines with +/- prefixes. */
  diff?: string;
  /** Error message if preview failed. */
  error?: string;
}

// =============================================================================
// Generic tool preview (fallback)
// =============================================================================

export function renderGenericPreview(args: Record<string, unknown>): RenderedToolPreview {
  const glyphs = getGlyphs();
  const keys = Object.keys(args);
  const details = keys.slice(0, 10).map((key) => {
    const value = args[key];
    const display = typeof value === "string"
      ? value.length > 80 ? value.slice(0, 80) + glyphs.ellipsis : value
      : JSON.stringify(value);
    return `${key}: ${display}`;
  });

  if (keys.length > 10) {
    details.push(`${glyphs.ellipsis} and ${keys.length - 10} more arguments`);
  }

  return { title: "Arguments", details };
}

// =============================================================================
// Write file preview
// =============================================================================

export function renderWriteFilePreview(args: Record<string, unknown>): RenderedToolPreview {
  const filePath = (args.file_path ?? args.path ?? "unknown") as string;
  const content = (args.content ?? "") as string;

  const lines = content.split("\n");
  const details = [
    `File: ${filePath}`,
    `Size: ${content.length} bytes, ${lines.length} lines`,
  ];

  // Show first 30 lines
  const preview = lines.slice(0, 30).join("\n");
  const truncated = lines.length > 30
    ? preview + `\n... (${lines.length - 30} more lines)`
    : preview;

  return { title: "Write File", details, code: truncated };
}

// =============================================================================
// Edit file preview
// =============================================================================

export function renderEditFilePreview(args: Record<string, unknown>): RenderedToolPreview {
  const filePath = (args.file_path ?? args.path ?? "unknown") as string;
  const oldContent = (args.old_text ?? args.old_content ?? "") as string;
  const newContent = (args.new_text ?? args.new_content ?? "") as string;

  // Build a simple diff
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diffLines: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < Math.min(maxLen, 50); i++) {
    const oldLine = oldLines[i] ?? "";
    const newLine = newLines[i] ?? "";
    if (oldLine === newLine) {
      diffLines.push(`  ${oldLine}`);
    } else {
      if (oldLine) diffLines.push(`- ${oldLine}`);
      if (newLine) diffLines.push(`+ ${newLine}`);
    }
  }

  if (maxLen > 50) {
    diffLines.push(`... (${maxLen - 50} more lines)`);
  }

  return {
    title: "Edit File",
    details: [`File: ${filePath}`, `Changes: ${oldContent.length} → ${newContent.length} bytes`],
    diff: diffLines.join("\n"),
  };
}

// =============================================================================
// Execute / shell command preview
// =============================================================================

export function renderExecutePreview(args: Record<string, unknown>): RenderedToolPreview {
  const command = (args.command ?? args.cmd ?? "") as string;
  return {
    title: "Execute Shell Command",
    details: [`Command: ${command}`],
    code: command,
  };
}

// =============================================================================
// Web search / fetch URL preview
// =============================================================================

export function renderWebRequestPreview(args: Record<string, unknown>): RenderedToolPreview {
  const url = (args.url ?? "") as string;
  const query = (args.query ?? args.q ?? "") as string;
  const details = url ? [`URL: ${url}`] : [`Query: ${query}`];
  return { title: "Web Request", details };
}

// =============================================================================
// Task / subagent preview
// =============================================================================

export function renderTaskPreview(args: Record<string, unknown>): RenderedToolPreview {
  const description = (args.description ?? args.task ?? args.prompt ?? "") as string;
  const subagentType = (args.subagent_type ?? args.subagent_name ?? "default") as string;
  return {
    title: "Subagent Task",
    details: [`Type: ${subagentType}`, `Task: ${description}`],
  };
}
