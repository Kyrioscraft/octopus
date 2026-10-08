import { useMemo } from "react";
import { useChatStore } from "../stores/chat.js";
import type { TodoItem } from "../components/chat/companion/types.js";
import type { SubagentEvent } from "../components/chat/turn/types.js";

/**
 * Derive the companion panel's data (latest todo list + all subagent events)
 * from the message projection in the global chat store.
 *
 * These are the exact derivations that used to live inside `useChat` — they are
 * duplicated here (both are cheap pure functions over the same mirrored array)
 * because the companion is mounted at the layout level and cannot read the
 * chat hook's local state.
 */
export function useCompanionData(): {
  todos: TodoItem[];
  subagents: SubagentEvent[];
} {
  const msgs = useChatStore((s) => s.companionMsgs);

  const todos = useMemo<TodoItem[]>(() => {
    // Latest todo list (last write_todos in the last assistant turn).
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const m = msgs[mi];
      if (m.role !== "assistant" || !m.events) continue;
      for (let ei = m.events.length - 1; ei >= 0; ei--) {
        const ev = m.events[ei];
        if (ev.type === "tool" && ev.entry.name === "write_todos") {
          const t = ev.entry.args?.todos;
          if (Array.isArray(t)) return t as TodoItem[];
        }
      }
    }
    return [];
  }, [msgs]);

  const subagents = useMemo<SubagentEvent[]>(
    () =>
      msgs.flatMap((m) =>
        (m.events ?? []).filter((e): e is SubagentEvent => e.type === "subagent"),
      ),
    [msgs],
  );

  return { todos, subagents };
}