import type { TurnEvent } from "./turn/types.js";

/**
 * A single chat message — the unit rendered as one bubble/turn in the
 * conversation. This is the view model shared by Chat.tsx, the message-list
 * components, and the chat hooks (thread history + stream consumer).
 *
 * `events[]` is the source of truth for assistant turns (an ordered timeline of
 * reasoning / tool / text / subagent events in real execution order). `content`
 * is kept in sync for backwards-compat with persistence and any code that still
 * reads it directly.
 */
export interface Msg {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  status?: string;
  /**
   * Ordered timeline of events for this assistant turn (reasoning / tool /
   * text / subagent), in real execution order. Replaces the old flat
   * reasoning/content/toolCalls fields as the source of truth for rendering.
   * `content` is kept in sync for backwards-compat with persistence and any
   * code that still reads it.
   */
  events?: TurnEvent[];
  /** Legacy error hint (rendered outside the timeline). */
  error?: string;
  /** Turn start timestamp (ms) — drives the live "已工作 Xs" timer while streaming. */
  startedAtMs?: number;
  /** Frozen work duration (ms) — from persisted work_duration_ms; shown when the turn ended. */
  workDurationMs?: number;
}
