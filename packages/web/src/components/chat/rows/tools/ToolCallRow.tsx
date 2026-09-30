import { useState, useEffect, type ReactNode } from "react";
import { Collapse } from "antd";
import {
  CircleX,
} from "lucide-react";
import type { ToolCallEntry } from "./types.js";
import { getToolIcon, getToolDisplayName } from "./registry.js";
import { ShimmerText } from "../../ShimmerText.js";

/**
 * Universal skeleton for a single tool-call ROW (lightweight, single-line
 * header + collapsible body). The row is deliberately low-weight — no border or
 * background of its own: the surrounding trace rail ties the entries together
 * and the whole header is a hover-fill target.
 *
 * Specialized rows compose this and override the `header` / `body` slots.
 *
 * Default header (when `header` is not provided): "<icon> <displayName>".
 * Default body (when `body` is not provided): a <DefaultCardBody /> rendering
 * the args as formatted JSON plus the result text.
 *
 * Visual weight:
 *   - Normal: just the header line (status icon + tool icon + summary).
 *   - Error: a subtle error-tinted background + a 2px error bar on the left, so
 *     failures stand out at a glance.
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
 * The tool's own type icon is ALWAYS shown (muted while done/settled — the
 * running state is signalled by the shimmer on the tool name and the rail's
 * pulsing dot, so no spinner here). Error → CircleX.
 */
function RowIcon({ name, status }: { name: string; status: ToolCallEntry["status"] }) {
  if (status === "error") return <CircleX style={{ color: "var(--color-error-500)" }} />;
  return (
    <span style={{ color: "var(--text-tertiary)", display: "inline-flex", alignItems: "center" }}>
      {getToolIcon(name)}
    </span>
  );
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
        fontSize: 12.5,
        fontWeight: 500,
        color: "var(--text-tertiary)",
        minWidth: 0,
        // NOTE: deliberately NO `flex: 1`. With flex:1 the header would stretch
        // to fill the row, pushing antd's expand arrow (expandIconPosition="end")
        // all the way to the right edge. Without it, the arrow sits right after
        // the header content instead of right-aligning.
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <RowIcon name={entry.name} status={entry.status} />
      </span>
      {header ?? (
        // Running/pending: shimmer the tool name so the active row stands out;
        // done/error: plain label.
        entry.status === "running" || entry.status === "pending" ? (
          <ShimmerText text={displayName} fontSize={12.5} />
        ) : (
          <span>{displayName}</span>
        )
      )}
    </div>
  );

  return (
    <div
      className={`tool-call-row collapsible-row${expanded ? " is-expanded" : ""}`}
      style={{
        maxWidth: "100%",
        minWidth: 0,
        // Error emphasis: a subtle error-tinted background + a 2px error bar on
        // the left edge, so failed calls pop without a full border.
        ...(isError
          ? {
              background: "var(--color-error-50)",
              borderLeft: "2px solid var(--color-error-500)",
              paddingLeft: 8,
              borderRadius: "var(--radius-xs)",
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

/** The label style shared by the collapsed body panels' captions ("参数"/"结果"). */
const bodyLabelStyle: React.CSSProperties = {
  fontSize: "var(--text-2xs)",
  fontWeight: 500,
  color: "var(--text-tertiary)",
  marginBottom: 4,
};

/**
 * The header shared by the specialized tool rows: `<verb> · <detail>` where the
 * detail is a monospace path/command. One implementation for bash / read / write
 * / edit, so their headers can't drift apart.
 */
export function ToolRowHeader({
  verb,
  running = false,
  detail,
  detailTitle,
  tail,
}: {
  verb: string;
  running?: boolean;
  /** Monospace detail (a file name, a command). */
  detail?: string;
  /** Tooltip for the detail — usually the untruncated path. */
  detailTitle?: string;
  /** Extra trailing content (diff stats, line counts). */
  tail?: ReactNode;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      {running ? (
        <ShimmerText text={verb} fontSize={12.5} />
      ) : (
        <span style={{ color: "var(--text-tertiary)" }}>{verb}</span>
      )}
      <span style={{ color: "var(--text-disabled)" }}>·</span>
      {detail && (
        <code
          title={detailTitle ?? detail}
          className="mono"
          style={{
            fontSize: 12.5,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {detail}
        </code>
      )}
      {tail}
    </span>
  );
}

/** The shared mono surface used by args / results / command blocks. */
export function codeSurfaceStyle(accent?: "error"): React.CSSProperties {
  const isError = accent === "error";
  return {
    fontSize: 12,
    lineHeight: 1.6,
    color: isError ? "var(--color-error-700)" : "var(--text-secondary)",
    background: isError ? "var(--color-error-50)" : "var(--bg-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "10px 12px",
    border: `1px solid ${isError ? "var(--color-error-100)" : "var(--border-default)"}`,
    margin: 0,
    fontFamily: "var(--font-mono)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
}

/**
 * Fallback body: render args as pretty JSON and the result as preformatted text.
 */
export function DefaultCardBody({ entry }: { entry: ToolCallEntry }) {
  const hasArgs = entry.args && Object.keys(entry.args).length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0 4px" }}>
      {hasArgs && (
        <div>
          <div style={bodyLabelStyle}>参数</div>
          <pre style={{ ...codeSurfaceStyle(), maxHeight: 300, overflow: "auto" }}>
            {JSON.stringify(entry.args, null, 2)}
          </pre>
        </div>
      )}
      {entry.result !== undefined && (
        <div>
          <div style={bodyLabelStyle}>结果</div>
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
        ...codeSurfaceStyle(isError ? "error" : undefined),
        maxHeight,
        overflow: "auto",
      }}
    >
      {result || (status === "pending" ? "执行中…" : "(空)")}
    </pre>
  );
}

/**
 * Small +N/-M pair for file-edit summaries — plain coloured monospace rather
 * than filled tags, so a diff stat reads as metadata instead of a badge.
 */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="mono tnum" style={{ display: "inline-flex", gap: 6, marginLeft: 4, fontSize: 11.5 }}>
      {added > 0 && <span style={{ color: "var(--color-success-700)" }}>+{added}</span>}
      {removed > 0 && <span style={{ color: "var(--color-error-700)" }}>-{removed}</span>}
    </span>
  );
}
