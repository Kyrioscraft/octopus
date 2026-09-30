import type { ToolCardProps } from "./types.js";
import { ToolCallRow, ToolResultBlock, codeSurfaceStyle } from "./ToolCallRow.js";
import { truncate } from "./registry.js";
import { ShimmerText } from "../../ShimmerText.js";

/**
 * execute / bash / run_shell_command row. Header shows the command (truncated);
 * body shows the command in full plus the captured output.
 *
 * The command block uses the shared mono surface (and the accent for the `$`
 * prompt) instead of a hard-coded dark block, so it belongs to the same surface
 * family as every other code panel and works in both themes.
 */
export function BashRow({ entry }: ToolCardProps) {
  const args = entry.args as { command?: string };
  const command = args.command ?? "";
  const running = entry.status === "running" || entry.status === "pending";

  return (
    <ToolCallRow
      entry={entry}
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {running ? (
            <ShimmerText text="执行" fontSize={12.5} />
          ) : (
            <span style={{ color: "var(--text-tertiary)" }}>执行</span>
          )}
          <span style={{ color: "var(--text-disabled)" }}>·</span>
          <code
            title={command}
            className="mono"
            style={{
              fontSize: 12.5,
              color: "var(--text-primary)",
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
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
          {command && (
            <div>
              <div
                style={{
                  fontSize: "var(--text-2xs)",
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                }}
              >
                命令
              </div>
              <pre style={codeSurfaceStyle()}>
                <span style={{ color: "var(--accent)" }}>$ </span>
                <span style={{ color: "var(--text-primary)" }}>{command}</span>
              </pre>
            </div>
          )}
          {entry.result !== undefined && (
            <div>
              <div
                style={{
                  fontSize: "var(--text-2xs)",
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                  marginBottom: 4,
                }}
              >
                输出
              </div>
              <ToolResultBlock result={entry.result} status={entry.status} maxHeight={360} />
            </div>
          )}
        </div>
      }
    />
  );
}