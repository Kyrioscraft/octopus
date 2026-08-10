// =============================================================================
// Shared tool utilities — used by both tui-adapter and message components.
// =============================================================================

/** File-modification tools — rendered with +N -M diff counts. */
export const FILE_EDIT_TOOLS = new Set([
  "write_file", "write",
  "edit_file", "edit",
]);

export function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.toLowerCase());
}

/** Compute added/removed line counts from tool args (edit_file / write_file). */
export function computeDiffStats(
  toolName: string,
  args: Record<string, unknown>,
): { added: number; removed: number } {
  const name = toolName.toLowerCase();
  if (name === "edit_file" || name === "edit") {
    const oldText = (args.old_text ?? args.old_string ?? "") as string;
    const newText = (args.new_text ?? args.new_string ?? "") as string;
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    return {
      added: Math.max(0, newLines.length - oldLines.length) || (newText ? newLines.length : 0),
      removed: oldLines.length,
    };
  }
  if (name === "write_file" || name === "write") {
    const content = (args.content ?? "") as string;
    return { added: content ? content.split("\n").length : 0, removed: 0 };
  }
  return { added: 0, removed: 0 };
}

export interface DiffLine {
  text: string;
  color: "red" | "green" | undefined;
}

/** Build rendered diff lines from edit_file / write_file args. */
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
