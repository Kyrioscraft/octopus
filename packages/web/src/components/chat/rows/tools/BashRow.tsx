import type { ToolCardProps } from "./types.js";
import { ToolCallRow, ToolResultBlock } from "./ToolCallRow.js";
import { truncate } from "./registry.js";
import { ShimmerText } from "../../ShimmerText.js";

/**
 * execute / bash / run_shell_command row. Header shows the command (truncated);
 * body shows the command in full plus the captured output.
 */
export function BashRow({ entry, defaultExpanded }: ToolCardProps) {
  const args = entry.args as { command?: string };
  const command = args.command ?? "";
  const running = entry.status === "running" || entry.status === "pending";

  return (
    <ToolCallRow
entry={entry}
defaultExpanded={defaultExpanded}
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {running ? <ShimmerText text="命令" /> : <span style={{ color: "var(--gray-500)" }}>命令</span>}
          <span style={{ color: "var(--gray-400)" }}>|</span>
          <code
            title={command}
            style={{
              fontSize: 12,
              color: "var(--gray-900)",
              fontFamily: "SFMono-Regular, Consolas, Menlo, monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {command ? truncate(command, 70) : "(empty)"}
          </code>
        </span>
      }
      body={
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
          {command && (
            <div>
              <div style={{ fontSize: 11, color: "var(--gray-500)", marginBottom: 4 }}>$ 命令</div>
              <pre
                style={{
                  fontSize: 12,
                  color: "var(--gray-900)",
                  background: "var(--gray-1000)" === "var(--gray-1000)" ? "#1e1f1f" : "var(--gray-1000)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  margin: 0,
                  fontFamily: "SFMono-Regular, Consolas, Menlo, monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                <span style={{ color: "var(--gray-400)" }}>$ </span>
                <span style={{ color: "#e6e8e8" }}>{command}</span>
              </pre>
            </div>
          )}
          {entry.result !== undefined && (
            <div>
              <div style={{ fontSize: 11, color: "var(--gray-500)", marginBottom: 4 }}>输出</div>
              <ToolResultBlock result={entry.result} status={entry.status} maxHeight={360} />
            </div>
          )}
        </div>
      }
    />
  );
}
