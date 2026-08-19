import { Progress, Tag, Empty } from "antd";
import {
  CircleCheckBig,
  Clock,
  Loader,
} from "lucide-react";
import type { TodoItem, TodoStatus } from "../types.js";
import type { CompanionPanelProps } from "../types.js";

/**
 * "待办" panel — todo list overview.
 *
 * Two regions:
 *   1. Progress overview — done/total (large) + percentage + a linear Progress
 *      bar colored by completion (all done = green, in progress = blue, none = gray).
 *   2. A list of todo rows — each row = status icon + content text + a status
 *      Tag (已完成 / 进行中 / 待处理). Completed items are grayed + struck-through.
 *
 * Data source: the `todos` array derived in Chat.tsx from the latest
 * `write_todos` tool call's args.todos.
 */
export function TodoPanel({ todos }: CompanionPanelProps) {
  if (todos.length === 0) {
    return (
      <div
        style={{
          height: "60%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ fontSize: 12, color: "var(--gray-400)" }}>暂无待办</span>
          }
        />
      </div>
    );
  }

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const allDone = done === total;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const barColor = allDone
    ? "var(--color-success-500)"
    : done > 0
      ? "var(--color-info-500)"
      : "var(--gray-300)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 4 }}>
      {/* Progress overview */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 22, fontWeight: 600, color: "var(--gray-800)" }}>
            {done}
            <span style={{ fontSize: 14, color: "var(--gray-400)" }}>/{total}</span>
          </span>
          <span style={{ fontSize: 12, color: "var(--gray-500)", marginLeft: "auto" }}>
            {pct}%
          </span>
        </div>
        <Progress
          percent={pct}
          showInfo={false}
          strokeColor={barColor}
          trailColor="var(--gray-150)"
          size="small"
        />
      </div>

      {/* Todo rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {todos.map((t, i) => (
          <TodoRow key={i} item={t} />
        ))}
      </div>
    </div>
  );
}

/** Status → (icon, color, label) for both the row icon and the Tag. */
export function statusVisual(status: TodoStatus): {
  icon: React.ReactNode;
  color: string;
  label: string;
} {
  switch (status) {
    case "completed":
      return {
        icon: <CircleCheckBig />,
        color: "var(--color-success-500)",
        label: "已完成",
      };
    case "in_progress":
      return {
        icon: <Loader size={14} style={{ animation: "spin 0.8s linear infinite" }} />,
        color: "var(--color-info-700)",
        label: "进行中",
      };
    case "pending":
    default:
      return {
        icon: <Clock />,
        color: "var(--gray-400)",
        label: "待处理",
      };
  }
}

/** A single todo row: status icon + content + status Tag. */
export function TodoRow({ item }: { item: TodoItem }) {
  const { icon, color, label } = statusVisual(item.status);
  const completed = item.status === "completed";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 4px",
        borderBottom: "1px solid var(--gray-100)",
      }}
    >
      <span style={{ color, fontSize: 15, flexShrink: 0 }}>{icon}</span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          lineHeight: "20px",
          color: completed ? "var(--gray-400)" : "var(--gray-800)",
          textDecoration: completed ? "line-through" : "none",
          wordBreak: "break-word",
        }}
      >
        {item.content}
      </span>
      <Tag
        style={{
          margin: 0,
          fontSize: 11,
          lineHeight: "18px",
          borderRadius: 4,
          border: "none",
          background: "var(--gray-100)",
          color,
          flexShrink: 0,
        }}
      >
        {label}
      </Tag>
    </div>
  );
}
