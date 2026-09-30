import { create } from "zustand";

/**
 * Display settings store — pure client-side display preferences for the
 * message stream. Nothing here is sent to the server.
 *
 * Persistence follows the project convention (see `theme.ts` / `chat.ts`):
 * manual `localStorage`, no zustand `persist` middleware.
 */
interface DisplaySettingsState {
  /**
   * Show ALL reasoning blocks per assistant turn.
   * false (default) → only the FIRST reasoning block of each turn is
   * rendered; later interleaved thinking blocks are dropped (ZCode
   * `messageStreamShowReasoning` semantics).
   */
  showFullReasoning: boolean;
  setShowFullReasoning: (v: boolean) => void;

  /**
   * Fold a turn's execution trail (reasoning + tool calls) away once the turn
   * finishes. true (default) → the trail expands while the agent works and
   * collapses to a "已完成 · N 步" line when it stops; a manual toggle still wins
   * for that block. false → trails stay wherever the user left them.
   */
  autoCollapseTrace: boolean;
  setAutoCollapseTrace: (v: boolean) => void;
}

const STORAGE_KEY = "octopus.message-stream-show-reasoning";
const TRACE_STORAGE_KEY = "octopus.auto-collapse-trace";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return false;
}

/** Defaults to true, so an absent key means "collapse finished trails". */
function readAutoCollapse(): boolean {
  try {
    return localStorage.getItem(TRACE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export const useDisplaySettingsStore = create<DisplaySettingsState>((set) => ({
  showFullReasoning: readStored(),
  setShowFullReasoning: (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
    } catch {
      /* ignore storage errors */
    }
    set({ showFullReasoning: v });
  },
  autoCollapseTrace: readAutoCollapse(),
  setAutoCollapseTrace: (v) => {
    try {
      localStorage.setItem(TRACE_STORAGE_KEY, v ? "true" : "false");
    } catch {
      /* ignore storage errors */
    }
    set({ autoCollapseTrace: v });
  },
}));
