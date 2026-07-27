import type { ToolCardProps } from "../types.js";
import { ToolCallCard, ToolResultBlock, DiffStat } from "../ToolCallCard.js";
import { basename, countLines } from "../registry.js";

/**
 * write_file card. Header shows the file name + a +N (line count) tag; body
 * shows the full file content (which is the `content` argument — there's no
 * "before" to diff against for a fresh write).
 */
export function FileWriteCard({ entry }: ToolCardProps) {
  const args = entry.args as { file_path?: string; content?: string };
  const filePath = args.file_path ?? "";
  const fileName = basename(filePath);
  const content = args.content ?? "";
  const added = countLines(content);

  return (
    <ToolCallCard
      entry={entry}
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ color: "var(--gray-700)" }}>写入</span>
          <span style={{ color: "var(--gray-300)" }}>|</span>
          <code
            title={filePath}
            style={{
              fontSize: 12,
              background: "var(--gray-100)",
              padding: "1px 6px",
              borderRadius: 4,
              color: "var(--gray-900)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fileName || "(unknown)"}
          </code>
          <DiffStat added={added} removed={0} />
        </span>
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
