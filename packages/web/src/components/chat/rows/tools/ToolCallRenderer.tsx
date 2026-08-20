import type { ToolCardProps } from "./types.js";
import { DefaultRow } from "./DefaultRow.js";
import { FileEditRow } from "./FileEditRow.js";
import { FileWriteRow } from "./FileWriteRow.js";
import { FileReadRow } from "./FileReadRow.js";
import { BashRow } from "./BashRow.js";

/**
 * Registry: tool name → specialized row component. Tools not listed here
 * fall back to <DefaultRow />. Adding a new row only requires one line.
 *
 * Note: the `task` tool (subagent delegation) is NOT registered here — it is
 * rendered as a SubagentRow (see rows/subagents/SubagentRow.tsx), not a flat
 * row. `task` tool events are skipped in TurnEventAccumulator for this reason.
 */
const TOOL_RENDERERS: Record<string, React.ComponentType<ToolCardProps>> = {
  // File edits
  edit_file: FileEditRow,
  replace: FileEditRow,
  write_file: FileWriteRow,
  // File reads
  read_file: FileReadRow,
  // Shell
  execute: BashRow,
  bash: BashRow,
  run_shell_command: BashRow,
  cmd: BashRow,
};

export interface ToolCallRendererProps extends ToolCardProps {
  /** When true (e.g. the parent group is streaming), rows default to expanded. */
  defaultExpanded?: boolean;
}

/**
 * Dispatcher: pick the specialized row for a tool, or fall back to DefaultRow.
 */
export function ToolCallRenderer({ entry, defaultExpanded }: ToolCallRendererProps) {
  const Renderer = TOOL_RENDERERS[entry.name] ?? DefaultRow;
  return <Renderer entry={entry} />;
}
