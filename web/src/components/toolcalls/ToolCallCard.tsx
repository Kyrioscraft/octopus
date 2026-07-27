import { useState, useEffect, type ReactNode } from "react";
import { Collapse, Tag } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import type { ToolCallEntry } from "./types.js";
import { getToolIcon, getToolDisplayName } from "./registry.js";

/**
 * Universal skeleton for a single tool-call card. Mirrors yuxi's BaseToolCall:
 * a status icon + tool icon + header summary + collapsible body. Specialized
 * cards compose this and override the `header` / `body` slots.
 *
 * Default header (when `header` is not provided): "<icon> <displayName>".
 * Default body (when `body` is not provided): a <DefaultCardBody /> rendering
 * the args as formatted JSON plus the result text.
 */
export interface ToolCallCardProps {
  entry: ToolCallEntry;
  /** Custom header content (placed after the status + tool icons). */
  header?: ReactNode;
  /** Custom expanded body. */
  body?: ReactNode;
  /** Force expanded state (used by the group during active streaming). */
  defaultExpanded?: boolean;
}

function StatusIcon({ status }: { status: ToolCallEntry["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircleFilled style={{ color: "var(--color-success-500)" }} />;
    case "error":
      return <CloseCircleFilled style={{ color: "var(--color-error-500)" }} />;
    case "running":
      return <LoadingOutlined style={{ color: "var(--color-info-700)" }} />;
    case "pending":
    default:
      return <ClockCircleOutlined style={{ color: "var(--gray-400)" }} />;
  }
}

export function ToolCallCard({ entry, header, body, defaultExpanded }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded ?? false);

  // When defaultExpanded flips to true (e.g. the parent group becomes active
  // during streaming), expand to follow. We intentionally do NOT auto-collapse
  // back — once the user (or the active-stream signal) opens it, leave it.
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);

  const icon = getToolIcon(entry.name);
  const displayName = getToolDisplayName(entry.name);

  const headerNode = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        fontWeight: 500,
        color: "var(--gray-700)",
        letterSpacing: "0.025em",
        minWidth: 0,
        flex: 1,
      }}
    >
      <StatusIcon status={entry.status} />
      <span style={{ color: "var(--gray-600)", display: "inline-flex", alignItems: "center" }}>
        {icon}
      </span>
      {header ?? <span>{displayName}</span>}
    </div>
  );

  return (
    <div
      className="tool-call-card"
      style={{
        borderLeft: "2px solid var(--gray-200)",
        paddingLeft: 10,
        marginLeft: 4,
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
 * specialized cards (bash, file ops) that want to show the raw tool output.
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
