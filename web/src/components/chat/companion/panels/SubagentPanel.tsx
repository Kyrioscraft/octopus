import { useEffect, useState } from "react";
import { Segmented, Empty } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { TurnEvents } from "../../turn/TurnEvents.js";
import { getSubagentDisplayName } from "../../rows/subagents/display.js";
import type { SubagentEvent } from "../../turn/types.js";
import type { CompanionPanelProps } from "../types.js";

/**
 * Subagent panel — renders one subagent run's internal timeline.
 *
 * Two modes, driven by the tab's `refId`:
 *   - refId set: focus a specific subagent run directly (a tab opened from an
 *     inline chip). Falls back to the overview if that run is no longer present.
 *   - refId unset: overview mode — a Segmented switch lists all runs; selection
 *     auto-follows the latest (streaming) run.
 */
export function SubagentPanel({ subagents, refId }: CompanionPanelProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  // The run to show: refId wins if valid, else the local selection.
  const refRun = refId ? subagents.find((s) => s.id === refId) : undefined;
  const pool = refRun ? [refRun] : subagents;

  // Keep the (overview-mode) selection valid + auto-follow the latest run.
  useEffect(() => {
    if (pool.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined);
      return;
    }
    if (!pool.some((s) => s.id === selectedId)) {
      setSelectedId(pool[pool.length - 1].id);
    }
  }, [pool, selectedId]);

  if (pool.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ fontSize: 12, color: "var(--gray-400)" }}>
              暂无子智能体执行记录
            </span>
          }
        />
      </div>
    );
  }

  const selected = pool.find((s) => s.id === selectedId) ?? pool[pool.length - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Selector — only in overview mode with more than one run. */}
      {!refRun && pool.length > 1 && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--gray-100)" }}>
          <Segmented
            block
            size="small"
            value={selected.id}
            onChange={(val) => setSelectedId(val as string)}
            options={pool.map((s, i) => ({
              label: (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    maxWidth: 120,
                    overflow: "hidden",
                  }}
                >
                  <RobotOutlined style={{ fontSize: 11 }} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {getSubagentDisplayName(s.displayName)}
                    {pool.filter((x) => (x.displayName ?? x.agentNs) === (s.displayName ?? s.agentNs)).length > 1 ? ` ${i + 1}` : ""}
                  </span>
                </span>
              ),
              value: s.id,
            }))}
          />
        </div>
      )}

      {/* Header for the selected subagent. */}
      <div
        style={{
          padding: "10px 16px 6px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <RobotOutlined style={{ fontSize: 14, color: "var(--main-color)" }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--gray-1000)" }}>
          {getSubagentDisplayName(selected.displayName)}
        </span>
        {selected.status === "streaming" ? (
          <span style={{ fontSize: 11, color: "var(--color-info-700)" }}>执行中</span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--color-success-700)" }}>已完成</span>
        )}
      </div>
      {selected.description && (
        <div
          style={{
            padding: "0 16px 8px",
            fontSize: 12,
            color: "var(--gray-500)",
            whiteSpace: "pre-wrap",
            flexShrink: 0,
          }}
        >
          {selected.description}
        </div>
      )}

      {/* Internal timeline — same rendering as the main conversation, so a
          subagent run looks identical to a top-level turn. When there are no
          captured internal steps (e.g. history reconstruction), fall back to
          the subagent's textual result so the panel isn't empty. */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 16px 16px" }}>
        {selected.events.length > 0 ? (
          <TurnEvents
            events={selected.events}
            isActive={selected.status === "streaming"}
          />
        ) : selected.result ? (
          <div
            style={{
              paddingLeft: 6,
              paddingTop: 4,
              fontSize: 12,
              color: "var(--gray-500)",
              whiteSpace: "pre-wrap",
            }}
          >
            {selected.result}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Re-export the SubagentEvent type for convenience (callers may import it). */
export type { SubagentEvent };
