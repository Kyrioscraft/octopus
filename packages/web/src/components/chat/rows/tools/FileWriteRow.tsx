import type { ToolCardProps } from "./types.js";
import { ToolCallRow, ToolResultBlock, DiffStat, ToolRowHeader } from "./ToolCallRow.js";
import { basename, countLines } from "./registry.js";

/**
 * write_file row. Header shows the file name + a +N (line count) stat; body
 * shows the full file content (which is the `content` argument — there's no
 * "before" to diff against for a fresh write).
 */
export function FileWriteRow({ entry }: ToolCardProps) {
  const args = entry.args as { file_path?: string; content?: string };
  const filePath = args.file_path ?? "";
  const fileName = basename(filePath);
  const content = args.content ?? "";
  const added = countLines(content);
  const running = entry.status === "running" || entry.status === "pending";

  return (
    <ToolCallRow
      entry={entry}
      header={
        <ToolRowHeader
          verb="写入"
          running={running}
          detail={fileName || "(unknown)"}
          detailTitle={filePath}
          tail={<DiffStat added={added} removed={0} />}
        />
      }
      body={
        content ? (
          <div style={{ paddingTop: 4 }}>
            <ToolResultBlock result={content} status={entry.status} maxHeight={420} />
          </div>
        ) : undefined
      }
    />
  );
}