import type { ToolCardProps } from "./types.js";
import { DefaultCard } from "./cards/DefaultCard.js";
import { FileEditCard } from "./cards/FileEditCard.js";
import { FileWriteCard } from "./cards/FileWriteCard.js";
import { FileReadCard } from "./cards/FileReadCard.js";
import { BashCard } from "./cards/BashCard.js";
import { TaskCard } from "./cards/TaskCard.js";

/**
 * Registry: tool name → specialized card component. Tools not listed here
 * fall back to <DefaultCard />. Adding a new card only requires one line.
 */
const TOOL_RENDERERS: Record<string, React.ComponentType<ToolCardProps>> = {
  // File edits
  edit_file: FileEditCard,
  replace: FileEditCard,
  write_file: FileWriteCard,
  // File reads
  read_file: FileReadCard,
  // Shell
  execute: BashCard,
  bash: BashCard,
  run_shell_command: BashCard,
  cmd: BashCard,
  // Subagent
  task: TaskCard,
};

export interface ToolCallRendererProps extends ToolCardProps {
  /** When true (e.g. the parent group is streaming), cards default to expanded. */
  defaultExpanded?: boolean;
}

/**
 * Dispatcher: pick the specialized card for a tool, or fall back to DefaultCard.
 */
export function ToolCallRenderer({ entry, defaultExpanded }: ToolCallRendererProps) {
  const Renderer = TOOL_RENDERERS[entry.name] ?? DefaultCard;
  return <Renderer entry={entry} />;
}
