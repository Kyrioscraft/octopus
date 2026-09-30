import { create } from "zustand";

/**
 * UI-chrome store — layout preferences that are not tied to a conversation.
 *
 * Currently just the sidebar collapse state, so the chat/workspace surface can be
 * given the full width. Persistence follows the project convention (see
 * `chat.ts` / `theme.ts`): manual `localStorage`, no zustand `persist` middleware.
 */

const STORAGE_KEY = "octopus.sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

interface UiState {
  /** True when the sidebar is reduced to its 60px icon rail. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: readCollapsed(),
  setSidebarCollapsed: (collapsed) => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore storage errors (private mode / disabled) */
    }
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
}));