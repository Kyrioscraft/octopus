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
}

const STORAGE_KEY = "octopus.message-stream-show-reasoning";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return false;
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
}));
