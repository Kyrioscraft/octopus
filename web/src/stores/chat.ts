import { create } from "zustand";
import type { Thread } from "@octopus/tentacle";

interface ChatState {
  threads: Thread[];
  activeThreadId: string | undefined;
  configOpen: boolean;
  setThreads: (threads: Thread[]) => void;
  setActiveThreadId: (id: string | undefined) => void;
  setConfigOpen: (open: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  threads: [],
  activeThreadId: undefined,
  configOpen: false,
  setThreads: (threads) => set({ threads }),
  setActiveThreadId: (id) => set({ activeThreadId: id }),
  setConfigOpen: (open) => set({ configOpen: open }),
}));
