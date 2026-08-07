// =============================================================================
// Session/thread management for the TUI.
// Equivalent to Python tui.sessions — uses OctopusClient for server-side
// persistence plus local SQLite checkpointer for LangGraph state.
// =============================================================================

import type { Thread } from "@octopus/tentacle";
import { formatRelativeTimestamp, formatPath } from "../utils/formatting.js";
import type { TuiClient } from "./client.js";
import { getLogger } from "../utils/logging.js";
import chalk from "chalk";

const logger = getLogger("tui.sessions");

// =============================================================================
// Thread info (enriched thread data for display)
// =============================================================================

export interface ThreadInfo {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  messageCount?: number;
  initialPrompt?: string;
  relativeTime: string;
}

// =============================================================================
// Thread listing
// =============================================================================

/**
 * List threads for the current user, enriched with display metadata.
 * Equivalent to Python `list_threads()`.
 */
export async function listThreads(client: TuiClient): Promise<ThreadInfo[]> {
  const threads = await client.listThreads();

  return threads.map((t) => ({
    id: t.id,
    title: t.title || "(untitled)",
    agentId: t.agentId,
    createdAt: t.createdAt,
    relativeTime: formatRelativeTimestamp(t.createdAt),
  }));
}

/**
 * Generate a new thread ID (UUID v4).
 * Equivalent to Python `generate_thread_id()`.
 */
export function generateThreadId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older Node versions
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Delete a thread.
 * Equivalent to Python `delete_thread()`.
 */
export async function deleteThread(client: TuiClient, threadId: string): Promise<boolean> {
  try {
    await client.deleteThread(threadId);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// CLI handler
// =============================================================================

/**
 * CLI handler for `octopus-tui threads` — list threads with Rich-like formatting.
 * Equivalent to Python `list_threads_command()`.
 */
export async function listThreadsCommand(opts: {
  server?: string;
  token?: string;
}): Promise<void> {
  const { TuiClient } = await import("./client.js");
  const client = new TuiClient({ baseUrl: opts.server, token: opts.token });

  try {
    const threads = await listThreads(client);
    if (threads.length === 0) {
      console.log("  No threads found.");
      return;
    }

    console.log(chalk.bold("Threads:"));
    for (const thread of threads) {
      const id = chalk.dim(thread.id.slice(0, 8));
      const time = chalk.dim(thread.relativeTime);
      const title = thread.title || chalk.italic("(untitled)");
      console.log(`  ${id}  ${chalk.cyan(title)}  ${time}`);
    }
  } catch (err) {
    logger.exception("Failed to list threads", err);
    console.error(chalk.red(`Error listing threads: ${(err as Error).message}`));
    process.exit(1);
  }
}
