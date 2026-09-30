import { CheckSquare } from "lucide-react";
import { useChatStore } from "../../../stores/chat.js";
import type { TodoItem } from "../companion/types.js";

/**
 * Todo progress badge for the chat header.
 *
 * `write_todos` is no longer rendered as a tool card in the conversation
 * timeline; instead, the latest todo list is surfaced here — a compact badge
 * in the chat header, to the left of the companion-panel toggle. The badge
 * shows a status dot + "done/total" count; the dot carries the state (green =
 * all done, blue = in progress, grey = none done) while the pill itself stays
 * neutral so the header doesn't turn into a traffic light. Clicking it opens
 * the right-side companion panel and auto-activates the "待办" tab.
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

  // Status dot by progress.
  const dot = allDone
    ? "var(--color-success-500)"
    : done > 0
      ? "var(--color-info-500)"
      : "var(--border-strong)";

  const title = allDone ? "待办已全部完成" : `待办 · ${done}/${total}`;

  const openCompanion = () => {
    openCompanionTab("todos");
  };

  return (
    <button
      type="button"
      title={title}
      onClick={openCompanion}
      className="pill focus-ring"
      style={{ cursor: "pointer" }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0 }}
      />
      <CheckSquare style={{ fontSize: 13, color: "var(--text-tertiary)" }} />
      <span className="tnum">
        {done}/{total}
      </span>
    </button>
  );
}
