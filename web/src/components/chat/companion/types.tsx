import type { ReactNode } from "react";
import {
  LayoutGrid,
  CheckSquare,
  Bot,
} from "lucide-react";
import type { CompanionTabKind } from "../../../stores/chat.js";
import type { SubagentEvent } from "../turn/types.js";

// =============================================================================
// Todo list (write_todos tool)
// =============================================================================
// The `write_todos` tool (deepagents' todoListMiddleware) maintains a todo
// list. Each call REPLACES the whole list with a new array. Its args shape is
// `{ todos: TodoItem[] }`. We surface the latest todos as a badge in the input
// toolbar (TodoBadge) + a panel here, instead of rendering write_todos as a
// tool row. These types live here (not in rows/tools/) because their only
// consumers are the companion panel + the input badge.

/** Lifecycle status of a single todo item (mirrors deepagents' TodoStatus). */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** A single todo item. Note: deepagents' write_todos has no priority field. */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/**
 * Shared types + metadata for the generic companion panel feature.
 *
 * The companion panel is a general-purpose secondary surface (right column,
 * below the chat header). It hosts browser-style tabs, each rendering a feature
 * "panel". This file centralizes the tab catalog (kind → icon + label) and the
 * props bundle passed down to every panel, so the container (`index.tsx`) and the
 * panels stay decoupled.
 */

/** Icon + short label for each tab kind, shown in the tab strip + add menu. */
export const TAB_META: Record<CompanionTabKind, { icon: ReactNode; label: string }> = {
  files: { icon: <LayoutGrid />, label: "文件" },
  subagents: { icon: <Bot />, label: "子智能体" },
  todos: { icon: <CheckSquare />, label: "待办" },
};

/**
 * Data bundle available to every panel. The container gathers conversation-
 * derived data (subagents, todos) once and hands it to whichever panel is
 * active. Panels take only the fields they need.
 */
export interface CompanionPanelProps {
  /** All subagent runs in the conversation (for the subagents panel). */
  subagents: SubagentEvent[];
  /** The latest todo list (for the todos panel). */
  todos: TodoItem[];
  /**
   * Optional sub-selection carried by the tab (e.g. a specific subagent run id
   * when the tab was opened from an inline chip). Panels may use it to focus a
   * specific item instead of showing an overview.
   */
  refId?: string;
}
