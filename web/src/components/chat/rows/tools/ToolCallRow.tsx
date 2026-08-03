import { useState, useEffect, type ReactNode } from "react";
import { Collapse, Tag } from "antd";
import {
  CircleX,
  LoaderCircle,
  Clock,
} from "lucide-react";
import type { ToolCallEntry } from "./types.js";
import { getToolIcon, getToolDisplayName } from "./registry.js";

/**
 * Universal skeleton for a single tool-call ROW (lightweight, single-line
 * header + collapsible body). Replaces the former "card" framing: the row is
 * deliberately low-weight — no border or background of its own, relying on the
 * parent timeline's left rail to tie events together.
 *
 * Specialized rows compose this and override the `header` / `body` slots.
 *
 * Default header (when `header` is not provided): "<icon> <displayName>".
 * Default body (when `body` is not provided): a <DefaultCardBody /> rendering
 * the args as formatted JSON plus the result text.
 *
 * Visual weight:
 *   - Normal: just the header line (status icon + tool icon + summary).
 *   - Error: the whole row gets a subtle error-tinted background + a 2px
 *     error-colored left bar, so failures stand out at a glance.
 */
export interface ToolCallRowProps {
  entry: ToolCallEntry;
  /** Custom header content (placed after the status + tool icons). */
  header?: ReactNode;
  /** Custom expanded body. */
  body?: ReactNode;
  /** Force expanded state (used by the group during active streaming). */
  defaultExpanded?: boolean;
}

/**
 * Single-slot icon for a tool row.
 *
 * Done → the tool's own type icon (the status is implied by completion).
 * Running → a spinner (hides the type icon while in flight, avoiding the
 *           visual redundancy of "spinner + type-icon" side by side).
 * Error / pending → status icon (these states still need to stand out).
 */
function RowIcon({ name, status }: { name: string; status: ToolCallEntry["status"] }) {
  switch (status) {
    case "done":
      return <>{getToolIcon(name)}</>;
    case "running":
      return <LoaderCircle style={{ color: "var(--color-info-700)" }} />;
    case "error":
      return <CircleX style={{ color: "var(--color-error-500)" }} />;
    case "pending":
    default:
      return <Clock style={{ color: "var(--gray-400)" }} />;
  }
}

export function ToolCallRow({ entry, header, body, defaultExpanded }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded ?? false);

  // When defaultExpanded flips to true (e.g. the parent group becomes active
  // during streaming), expand to follow. We intentionally do NOT auto-collapse
  // back — once the user (or the active-stream signal) opens it, leave it.
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);

  const displayName = getToolDisplayName(entry.name);
  const isError = entry.status === "error";

  const headerNode = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        fontWeight: 500,
        color: "var(--gray-500)",
        letterSpacing: "0.025em",
        minWidth: 0,
        // NOTE: deliberately NO `flex: 1`. With flex:1 the header would stretch
        // to fill the row, pushing antd's expand arrow (expandIconPosition="end")
        // all the way to the right edge. Without it, the arrow sits right after
        // the header content instead of right-aligning.
      }}
    >
      <span style={{ color: "var(--gray-600)", display: "inline-flex", alignItems: "center" }}>
        <RowIcon name={entry.name} status={entry.status} />
      </span>
      {header ?? <span>{displayName}</span>}
    </div>
  );

  return (
    <div
      className="tool-call-row"
      style={{
        // No own left rail — border-free reduces visual weight (the old card
        // drew a 2nd rail here, doubling up).
        maxWidth: "100%",
        minWidth: 0,
        // Error emphasis: a subtle error-tinted background + a 2px error bar on
        // the left edge, so failed calls pop without a full border.
        ...(isError
          ? {
              background: "var(--color-error-50)",
              borderLeft: "2px solid var(--color-error-200, var(--color-error-100))",
              paddingLeft: 8,
              borderRadius: 4,
            }
          : {}),
      }}
    >
      <Collapse
        ghost
        size="small"
        activeKey={expanded ? [entry.id] : []}
        onChange={(keys) => setExpanded(keys.length > 0)}
        expandIconPosition="end"
        items={[
          {
            key: entry.id,
            label: headerNode,
            children: body ?? <DefaultCardBody entry={entry} />,
          },
        ]}
      />
    </div>
  );
}

/**
 * Fallback body: render args as pretty JSON and the result as preformatted text.
 */
export function DefaultCardBody({ entry }: { entry: ToolCallEntry }) {
  const hasArgs = entry.args && Object.keys(entry.args).length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
      {hasArgs && (
        <div>
          <div style={{ fontSize: 11, color: "var(--gray-500)", marginBottom: 4 }}>参数</div>
          <pre
            style={{
              fontSize: 12,
              color: "var(--gray-700)",
              background: "var(--gray-25)",
              borderRadius: 6,
              padding: "8px 10px",
              border: "1px solid var(--gray-150)",
              margin: 0,
              fontFamily:
                "SFMono-Regular, Consolas, Menlo, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {JSON.stringify(entry.args, null, 2)}
          </pre>
        </div>
      )}
      {entry.result !== undefined && (
        <div>
          <div style={{ fontSize: 11, color: "var(--gray-500)", marginBottom: 4 }}>结果</div>
          <ToolResultBlock result={entry.result} status={entry.status} />
        </div>
      )}
    </div>
  );
}

/**
 * Render a tool's textual result with a status-aware accent. Used by several
 * specialized rows (bash, file ops) that want to show the raw tool output.
 */
export function ToolResultBlock({
  result,
  status,
  maxHeight = 320,
}: {
  result: string;
  status?: ToolCallEntry["status"];
  maxHeight?: number;
}) {
  const isError = status === "error";
  return (
    <pre
      style={{
        fontSize: 12,
        color: "var(--gray-700)",
        background: isError ? "var(--color-error-50)" : "var(--gray-25)",
        borderRadius: 6,
        padding: "8px 10px",
        border: `1px solid ${isError ? "var(--color-error-100)" : "var(--gray-150)"}`,
        margin: 0,
        fontFamily: "SFMono-Regular, Consolas, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight,
        overflow: "auto",
      }}
    >
      {result || (status === "pending" ? "执行中…" : "(空)")}
    </pre>
  );
}

/**
 * Small +N/-M tag pair for file-edit summaries.
 */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, marginLeft: 4 }}>
      {added > 0 && (
        <Tag color="success" style={{ margin: 0, fontSize: 11, lineHeight: "18px" }}>
          +{added}
        </Tag>
      )}
      {removed > 0 && (
        <Tag color="error" style={{ margin: 0, fontSize: 11, lineHeight: "18px" }}>
          -{removed}
        </Tag>
      )}
    </span>
  );
}
