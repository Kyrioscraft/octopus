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

/** The kind of panel a companion tab renders. Multiple tabs of the same kind
 *  can be open at once (browser-tab style). */
export type CompanionTabKind = "files" | "subagents" | "todos";

/** A single open tab in the companion panel (browser-tab style: openable, closable). */
export interface CompanionTabEntry {
  /** Unique id for this tab instance (allows multiple tabs of the same kind). */
  id: string;
  kind: CompanionTabKind;
  /** Optional sub-selection — e.g. which subagent this tab focuses on. */
  refId?: string;
}

// Persist the companion panel width so the user's preferred size survives reloads.
const COMPANION_WIDTH_KEY = "octopus.companionWidth";
const DEFAULT_COMPANION_WIDTH = 420;
const MIN_COMPANION_WIDTH = 280;
const MAX_COMPANION_WIDTH = 900;
const readCompanionWidth = (): number => {
  try {
    const v = Number(localStorage.getItem(COMPANION_WIDTH_KEY));
    if (Number.isFinite(v) && v >= MIN_COMPANION_WIDTH && v <= MAX_COMPANION_WIDTH) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_COMPANION_WIDTH;
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

  // ---- Generic right-side companion panel ----
  // An in-conversation container (right column, below the header) hosting
  // browser-style tabs. Tabs are openable (via a + menu or header buttons) and
  // closable (× on each tab). Multiple tabs of the same kind can coexist.
  /** Whether the companion panel is open. */
  companionOpen: boolean;
  setCompanionOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** The open tabs, in order. */
  companionTabs: CompanionTabEntry[];
  /** id of the currently-active tab (undefined if none). */
  activeCompanionTabId: string | undefined;
  /** Open a tab for a kind (dedupes `files`/`todos`; `subagents` can multi-open
   *  when given a distinct refId). Activates the tab and opens the companion panel. */
  openCompanionTab: (kind: CompanionTabKind, refId?: string) => void;
  /** Close a tab by id. Activates a neighbor. Closes the companion panel if emptied. */
  closeCompanionTab: (id: string) => void;
  /** Activate a tab by id. */
  setActiveCompanionTab: (id: string) => void;
  /** Companion panel width in px (persisted to localStorage). */
  companionWidth: number;
  setCompanionWidth: (v: number | ((prev: number) => number)) => void;
  /** Clamp helper used by the drag handle. */
  readonly minCompanionWidth: number;
  readonly maxCompanionWidth: number;
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

  companionOpen: false,
  setCompanionOpen: (v) =>
    set((state) => ({ companionOpen: typeof v === "function" ? v(state.companionOpen) : v })),
  companionTabs: [],
  activeCompanionTabId: undefined,
  openCompanionTab: (kind, refId) =>
    set((state) => {
      // files/todos are singletons (one tab of each kind is enough). subagents
      // can multi-open when given a distinct refId (one tab per subagent run).
      const singleton = kind === "files" || kind === "todos";
      if (singleton) {
        const existing = state.companionTabs.find((t) => t.kind === kind);
        if (existing) {
          return { companionOpen: true, activeCompanionTabId: existing.id };
        }
      } else if (refId) {
        const existing = state.companionTabs.find((t) => t.kind === kind && t.refId === refId);
        if (existing) {
          return { companionOpen: true, activeCompanionTabId: existing.id };
        }
      }
      const tab: CompanionTabEntry = {
        id: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        kind,
        ...(refId ? { refId } : {}),
      };
      return { companionOpen: true, companionTabs: [...state.companionTabs, tab], activeCompanionTabId: tab.id };
    }),
  closeCompanionTab: (id) =>
    set((state) => {
      const idx = state.companionTabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const next = state.companionTabs.filter((t) => t.id !== id);
      // Activate a neighbor (prefer the one now at the same index).
      const activeId =
        next.length === 0
          ? undefined
          : next[Math.min(idx, next.length - 1)].id;
      return { companionTabs: next, activeCompanionTabId: activeId, companionOpen: next.length > 0 && state.companionOpen };
    }),
  setActiveCompanionTab: (id) => set({ activeCompanionTabId: id }),
  companionWidth: readCompanionWidth(),
  setCompanionWidth: (v) =>
    set((state) => {
      const next = typeof v === "function" ? v(state.companionWidth) : v;
      const clamped = Math.max(MIN_COMPANION_WIDTH, Math.min(MAX_COMPANION_WIDTH, next));
      try {
        localStorage.setItem(COMPANION_WIDTH_KEY, String(clamped));
      } catch {
        /* ignore */
      }
      return { companionWidth: clamped };
    }),
  minCompanionWidth: MIN_COMPANION_WIDTH,
  maxCompanionWidth: MAX_COMPANION_WIDTH,
}));
