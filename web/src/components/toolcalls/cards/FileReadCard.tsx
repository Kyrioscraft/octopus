import type { ToolCardProps } from "../types.js";
import { ToolCallCard, ToolResultBlock } from "../ToolCallCard.js";
import { basename } from "../registry.js";

/**
 * read_file card. Header shows the file name; body shows the file contents
 * (which arrive as the tool result text, already formatted with line numbers
 * by the deepagents filesystem middleware).
 */
export function FileReadCard({ entry }: ToolCardProps) {
  const args = entry.args as { file_path?: string; offset?: number; limit?: number };
  const filePath = args.file_path ?? "";
  const fileName = basename(filePath);

  return (
    <ToolCallCard
      entry={entry}
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ color: "var(--gray-700)" }}>读取</span>
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
        </span>
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
