import { useEffect, useRef, useState, type ReactNode } from "react";
import { Collapse, Tag } from "antd";
import { CaretRightOutlined } from "@ant-design/icons";
import type { ToolCallEntry } from "./types.js";
import { ToolCallRenderer } from "./ToolCallRenderer.js";

export interface ToolCallGroupProps {
  toolCalls: ToolCallEntry[];
  /**
   * Whether the parent assistant message is actively streaming. When true the
   * group auto-expands (so the user sees live tool progress); once it flips
   * to false the group auto-collapses (to keep the conversation readable),
   * unless the user has manually opened it. Mirrors yuxi's
   * ToolCallsGroupComponent active-state behavior.
   */
  isActive?: boolean;
}

/**
 * A collapsible group that summarizes a batch of tool calls from one
 * assistant turn and renders each via <ToolCallRenderer /> in a timeline.
 */
export function ToolCallGroup({ toolCalls, isActive }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState<boolean>(isActive ?? false);
  // Tracks whether the user manually toggled, so auto-collapse on stream-end
  // doesn't fight a deliberate user open.
  const userTouchedRef = useRef(false);

  useEffect(() => {
    if (isActive) {
      // While streaming, force-expand (ignore prior user state — new tools
      // may be arriving and the user wants to see them).
      userTouchedRef.current = false;
      setExpanded(true);
    } else if (!userTouchedRef.current) {
      // Stream just ended and the user hasn't touched it — auto-collapse.
      setExpanded(false);
    }
  }, [isActive]);

  const total = toolCalls.length;
  const done = toolCalls.filter((t) => t.status === "done").length;
  const errored = toolCalls.filter((t) => t.status === "error").length;
  const pending = total - done - errored;

  const uniqueNames = Array.from(new Set(toolCalls.map((t) => t.name)));
  const visibleNames = uniqueNames.slice(0, 3);
  const extraNames = uniqueNames.length - visibleNames.length;

  const label = total === 1 ? "已调用 1 个工具" : `已调用 ${total} 个工具`;
  const statusNode = buildStatusNode({ done, errored, pending });

  return (
    <div style={{ width: "100%", marginTop: 8 }}>
      <Collapse
        ghost
        size="small"
        activeKey={expanded ? ["g"] : []}
        onChange={(keys) => {
          userTouchedRef.current = true;
          setExpanded(keys.length > 0);
        }}
        expandIcon={({ isActive: open }) => (
          <CaretRightOutlined rotate={open ? 90 : 0} style={{ fontSize: 12 }} />
        )}
        style={{
          background: "var(--gray-25)",
          borderRadius: 8,
          border: "1px solid var(--gray-150)",
        }}
        items={[
          {
            key: "g",
            label: (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--gray-600)",
                  letterSpacing: "0.025em",
                  flexWrap: "wrap",
                }}
              >
                <span>{label}</span>
                {visibleNames.map((n) => (
                  <Tag
                    key={n}
                    style={{
                      margin: 0,
                      fontSize: 11,
                      lineHeight: "18px",
                      background: "var(--gray-0)",
                      border: "1px solid var(--gray-200)",
                      color: "var(--gray-600)",
                    }}
                  >
                    {n}
                  </Tag>
                ))}
                {extraNames > 0 && (
                  <span style={{ fontSize: 11, color: "var(--gray-400)" }}>
                    +{extraNames}
                  </span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 11 }}>{statusNode}</span>
              </div>
            ),
            children: (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  paddingTop: 4,
                }}
              >
                {toolCalls.map((tc) => (
                  <ToolCallRenderer key={tc.id} entry={tc} defaultExpanded={isActive} />
                ))}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function buildStatusNode({
  done,
  errored,
  pending,
}: {
  done: number;
  errored: number;
  pending: number;
}): ReactNode {
  const parts: ReactNode[] = [];
  if (pending > 0) {
    parts.push(
      <span key="pend" style={{ color: "var(--color-info-700)" }}>
        {pending} 进行中
      </span>,
    );
  }
  if (done > 0) {
    parts.push(
      <span key="done" style={{ color: "var(--color-success-700)" }}>
        {done} 完成
      </span>,
    );
  }
  if (errored > 0) {
    parts.push(
      <span key="err" style={{ color: "var(--color-error-700)" }}>
        {errored} 失败
      </span>,
    );
  }
  if (parts.length === 0) {
    parts.push(
      <span key="idle" style={{ color: "var(--gray-400)" }}>
        等待
      </span>,
    );
  }
  return parts.flatMap((p, i) =>
    i === 0 ? [p] : [<span key={`sep${i}`} style={{ color: "var(--gray-300)" }}> · </span>, p],
  );
}
