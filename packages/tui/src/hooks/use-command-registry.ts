// =============================================================================
// useCommandRegistry — slash-command registry loading.
//
// Extracted from app.tsx. Fetches the server-authoritative command list,
// merges it with local bypass-tier metadata, discovers skills, and
// publishes the merged list + lookup index to state.
// =============================================================================

import { useState, useCallback } from "react";
import { TuiClient } from "../client/client.js";
import {
  fetchRemoteCommands, mergeCommands, buildCommandIndex, buildSkillCommands,
} from "../command-registry.js";
import type { MergedCommand } from "../command-registry.js";
import { getLogger } from "../utils/logging.js";

const logger = getLogger("tui.hooks.commands");

// =============================================================================
// Types
// =============================================================================

export interface UseCommandRegistryReturn {
  /** Merged command list (server + local + skills). */
  mergedCommands: MergedCommand[];
  /** Name → MergedCommand lookup (includes aliases). */
  commandIndex: Map<string, MergedCommand>;
  /** Discovered skill commands. */
  skills: { name: string; description: string }[];
  /**
   * Fetch commands from the server, merge with local data, and update state.
   * Safe to call multiple times (e.g. after /reload).
   */
  loadCommands: (client: TuiClient) => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

export function useCommandRegistry(): UseCommandRegistryReturn {
  const [mergedCommands, setMergedCommands] = useState<MergedCommand[]>([]);
  const [commandIndex, setCommandIndex] = useState<Map<string, MergedCommand>>(new Map());
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);

  const loadCommands = useCallback(async (client: TuiClient): Promise<void> => {
    try {
      const [remote, discoveredSkills] = await Promise.all([
        fetchRemoteCommands(client.client),
        (async () => {
          try {
            const { listSkills } = await import("@octopus/core");
            return listSkills();
          } catch {
            return [];
          }
        })(),
      ]);
      setSkills(discoveredSkills);
      const skillEntries = buildSkillCommands(discoveredSkills);
      const merged = mergeCommands(remote, skillEntries);
      setMergedCommands(merged);
      setCommandIndex(buildCommandIndex(merged));
    } catch (err) {
      logger.exception("Failed to load slash commands from server", err);
    }
  }, []);

  return { mergedCommands, commandIndex, skills, loadCommands };
}
