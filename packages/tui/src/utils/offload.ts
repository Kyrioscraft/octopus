// =============================================================================
// Context offload / compact logic — frees up context window space.
// Equivalent to Python tui.offload.
// =============================================================================

import type { ChatMessageData } from "../types.js";

// =============================================================================
// Offload result types
// =============================================================================

export interface OffloadResult {
  messagesOffloaded: number;
  tokensSaved: number;
  offloadedTo: string;
}

// =============================================================================
// Offload logic
// =============================================================================

/**
 * Determine how many messages should be kept and which can be offloaded.
 *
 * Equivalent to Python `perform_offload()`.
 *
 * Strategy:
 * 1. Keep the most recent messages (based on estimated token count)
 * 2. Offload older messages to the backend
 * 3. Insert a summarization message
 */
export function computeOffload(
  messages: ChatMessageData[],
  contextLimit: number,
  keepTokens: number = Math.floor(contextLimit * 0.6),
): { keep: ChatMessageData[]; offload: ChatMessageData[] } | null {
  if (messages.length === 0) return null;

  // Estimate tokens (rough: ~4 chars per token)
  const estimateTokens = (msg: ChatMessageData): number =>
    Math.ceil(msg.content.length / 4);

  let totalTokens = 0;
  let splitIdx = messages.length;

  // Walk backwards to find the cutoff
  for (let i = messages.length - 1; i >= 0; i--) {
    totalTokens += estimateTokens(messages[i]);
    if (totalTokens > keepTokens) {
      splitIdx = i + 1;
      break;
    }
  }

  const offload = messages.slice(0, splitIdx);
  const keep = messages.slice(splitIdx);

  if (offload.length === 0) return null;

  return { keep, offload };
}

/**
 * Generate a summarization message for offloaded content.
 */
export function generateOffloadSummary(
  offloadedMessages: ChatMessageData[],
): string {
  const userMsgs = offloadedMessages.filter((m) => m.role === "user").length;
  const assistantMsgs = offloadedMessages.filter((m) => m.role === "assistant").length;
  const toolMsgs = offloadedMessages.filter((m) => m.role === "tool").length;

  return [
    `[Context offloaded: ${offloadedMessages.length} messages]`,
    `${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool messages`,
    `Earliest: ${new Date(offloadedMessages[0].timestamp).toLocaleString()}`,
    `Latest: ${new Date(offloadedMessages[offloadedMessages.length - 1].timestamp).toLocaleString()}`,
  ].join("\n");
}

/**
 * Format the offload retention limit for display.
 * Equivalent to Python `format_offload_limit()`.
 */
export function formatOffloadLimit(
  keepCount: number,
  contextLimit: number,
): string {
  const pct = Math.round((keepCount / contextLimit) * 100);
  return `${keepCount} messages (${pct}% of ${contextLimit} token window)`;
}
