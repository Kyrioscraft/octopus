import type { ToolCardProps } from "./types.js";
import { ToolCallRow, ToolResultBlock, ToolRowHeader } from "./ToolCallRow.js";
import { basename } from "./registry.js";

/**
 * read_file row. Header shows the file name; body shows the file contents
 * (which arrive as the tool result text, already formatted with line numbers
 * by the deepagents filesystem middleware).
 */
export function FileReadRow({ entry }: ToolCardProps) {
  const args = entry.args as { file_path?: string; offset?: number; limit?: number };
  const filePath = args.file_path ?? "";
  const fileName = basename(filePath);
  const running = entry.status === "running" || entry.status === "pending";

  return (
    <ToolCallRow
      entry={entry}
      header={
        <ToolRowHeader
          verb="读取"
          running={running}
          detail={fileName || "(unknown)"}
          detailTitle={filePath}
        />
      }
      body={
        entry.result ? (
          <div style={{ paddingTop: 4 }}>
            <ToolResultBlock result={entry.result} status={entry.status} maxHeight={420} />
          </div>
        ) : undefined
      }
    />
  );
}