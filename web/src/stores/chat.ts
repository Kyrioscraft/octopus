import { create } from "zustand";
import type { Thread, Workspace } from "@octopus/tentacle";

// Persist the active workspace id so it survives the hard navigation used when
// switching conversations (window.location.href). Without this, the in-memory
// store resets and the user is bounced back to the most-recent workspace.
const ACTIVE_WS_KEY = "octopus.activeWorkspaceId";
const readActiveWs = (): string | undefined => {
  try {
    return localStorage.getItem(ACTIVE_WS_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

interface ChatState {
  threads: Thread[];
  activeThreadId: string | undefined;
  setThreads: (threads: Thread[]) => void;
  setActiveThreadId: (id: string | undefined) => void;
  /** All known workspaces (recents-ordered). */
  workspaces: Workspace[];
  setWorkspaces: (workspaces: Workspace[]) => void;
  /** The workspace the user is currently working in (IDE-style active folder). */
  activeWorkspaceId: string | undefined;
  setActiveWorkspaceId: (id: string | undefined) => void;
  /** Whether the right-side file-tree sider is collapsed. Shared so the chat
   * header's workspace button can toggle it. */
  fileTreeCollapsed: boolean;
  setFileTreeCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  threads: [],
  activeThreadId: undefined,
  setThreads: (threads) => set({ threads }),
  setActiveThreadId: (id) => set({ activeThreadId: id }),
  workspaces: [],
  setWorkspaces: (workspaces) => set({ workspaces }),
  activeWorkspaceId: readActiveWs(),
  setActiveWorkspaceId: (id) => {
    try {
      if (id) localStorage.setItem(ACTIVE_WS_KEY, id);
      else localStorage.removeItem(ACTIVE_WS_KEY);
    } catch {
      /* ignore storage errors */
    }
    set({ activeWorkspaceId: id });
  },
  fileTreeCollapsed: true,
  setFileTreeCollapsed: (v) =>
    set((state) => ({ fileTreeCollapsed: typeof v === "function" ? v(state.fileTreeCollapsed) : v })),
}));
