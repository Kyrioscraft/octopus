import { CheckSquareOutlined } from "@ant-design/icons";
import { useChatStore } from "../../../stores/chat.js";
import type { TodoItem } from "../companion/types.js";

/**
 * Todo progress badge for the input toolbar.
 *
 * `write_todos` is no longer rendered as a tool card in the conversation
 * timeline; instead, the latest todo list is surfaced here — a compact badge
 * right after the access-mode selector. The badge shows an icon + "done/total"
 * count and color-codes by progress (all done = green, in progress = blue,
 * none done = gray). Clicking it opens the right-side companion panel and
 * auto-activates the "待办" tab (see CompanionPanel / TodoPanel).
 *
 * Data source: the caller derives the latest `write_todos` call's args.todos
 * from the active/last assistant turn's events[].
 */
export function TodoBadge({ todos }: { todos: TodoItem[] }) {
  const openCompanionTab = useChatStore((s) => s.openCompanionTab);

  if (todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const allDone = done === total;

  // Badge color by progress.
  const color = allDone
    ? "var(--color-success-700)"
    : done > 0
      ? "var(--color-info-700)"
      : "var(--gray-500)";

  const title = allDone ? "待办已全部完成" : `待办 · ${done}/${total}`;

  const openCompanion = () => {
    openCompanionTab("todos");
  };

  return (
    <button
      type="button"
      title={title}
      onClick={openCompanion}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12,
        lineHeight: "20px",
        padding: "0 8px",
        borderRadius: 4,
        border: "1px solid var(--gray-200)",
        background: "transparent",
        color,
        cursor: "pointer",
      }}
    >
      <CheckSquareOutlined style={{ fontSize: 13 }} />
      <span>
        {done}/{total}
      </span>
    </button>
  );
}
