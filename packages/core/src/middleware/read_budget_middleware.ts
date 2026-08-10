/**
 * Read-budget middleware — runtime hints to curb over-exploration.
 *
 * Problem: the agent often reads 10+ files before acting, even when 2-3 would
 * suffice (observed in real traces). Prompt-level guidance ("explore with a
 * budget") is too weak — the model ignores it. This middleware provides
 * *runtime* feedback by scanning the conversation history before each model
 * call and, when over-reading is detected, appends a short `[hint]` to the
 * system message.
 *
 * Inspired by ZCode's Read tool, which returns "Wasted call — file unchanged
 * since your last Read" when the model re-reads an unchanged file. We extend
 * the idea to two signals:
 *
 * 1. **Re-read detection**: the last `read_file` call targets a file that was
 *    already read earlier in the conversation. The hint tells the model to
 *    refer to the earlier result instead.
 * 2. **Read-without-acting**: the model has read ≥ READ_BUDGET unique files
 *    without issuing any `edit_file` / `write_file` / `execute` calls. The
 *    hint nudges it to act or switch to `grep_search`.
 *
 * Design choices:
 * - **Soft hints only** — never blocks a read. The model can still read if it
 *   has a good reason; it just sees the warning.
 * - **Stateless** — re-scans `request.messages` on every `wrapModelCall`. No
 *   `stateSchema`, no cross-thread leakage, naturally idempotent.
 * - **Idempotent append** — checks whether the hint is already in the system
 *   message before appending, so it never stacks across turns.
 *
 * Placed after `FilesystemPolicyMiddleware` and before `LocalContextMiddleware`
 * in the stack (agent.ts ~line 640). The hint lands in the system message
 * *before* the SDK's `CacheBreakpointMiddleware` tags it, so it participates
 * in caching (stable text → cache-friendly).
 */

import type { BaseMessage } from "@langchain/core/messages";
import { getLogger } from "../logging.js";

const logger = getLogger("middleware.read_budget");

// =============================================================================
// Constants
// =============================================================================

/** Unique-file threshold. User expects ≤3 reads; allow 1 buffer → 4. */
const READ_BUDGET = 4;

/** Tool names that count as "reading" for budget purposes. */
const READ_TOOL_NAMES = new Set(["read_file", "readfile", "read"]);

/** Tool names that count as "acting" (making changes / running things). */
const ACT_TOOL_NAMES = new Set([
  "edit_file",
  "write_file",
  "execute",
  "shell",
  "bash",
]);

// =============================================================================
// Message helpers (adapted from resume_state.ts patterns)
// =============================================================================

function _isAiMessage(msg: BaseMessage): boolean {
  return (msg as any).type === "ai" || (msg as any)._getType?.() === "ai";
}

function _isToolMessage(msg: BaseMessage): boolean {
  return (
    (msg as any).type === "tool" || (msg as any)._getType?.() === "tool"
  );
}

interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

/** Extract tool_calls array from an AI message (may be absent/empty). */
function _getToolCalls(msg: BaseMessage): ToolCall[] {
  const calls = (msg as any).tool_calls;
  return Array.isArray(calls) ? calls : [];
}

/** Extract a file_path from a read_file tool-call's args. */
function _getPathFromArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const path = args.file_path ?? args.path ?? args.filename;
  return typeof path === "string" ? path : undefined;
}

// =============================================================================
// Analysis
// =============================================================================

interface ReadAnalysis {
  /** Distinct file paths read, in first-read order. */
  uniquePaths: string[];
  /** The path from the most recent read_file tool_call (if any). */
  lastReadPath: string | undefined;
  /** Whether the agent has issued any edit/write/execute call. */
  hasActed: boolean;
  /** Whether the last read_file targets a file already read before. */
  isReRead: boolean;
}

/**
 * Scan the message history to build a read/act picture.
 *
 * We walk messages in chronological order, tracking:
 * - `read_file` calls → collect paths (for uniqueness and last-read).
 * - `edit_file` / `write_file` / `execute` calls → mark `hasActed`.
 * - ToolMessages are skipped (they are results, not requests).
 *
 * `isReRead` is true when the *latest* read_file in the most recent AI message
 * targets a path that appeared in an *earlier* AI message's read_file.
 */
function _analyzeReads(messages: BaseMessage[]): ReadAnalysis {
  const pathOrder: string[] = [];
  const pathSet = new Set<string>();
  let hasActed = false;
  let lastReadPath: string | undefined;

  for (const msg of messages) {
    if (!_isAiMessage(msg)) continue;
    for (const tc of _getToolCalls(msg)) {
      if (READ_TOOL_NAMES.has(tc.name)) {
        const p = _getPathFromArgs(tc.args);
        if (p) {
          lastReadPath = p;
          if (!pathSet.has(p)) {
            pathSet.add(p);
            pathOrder.push(p);
          }
        }
      } else if (ACT_TOOL_NAMES.has(tc.name)) {
        hasActed = true;
      }
    }
  }

  // Detect re-read: if lastReadPath appears more than once across ALL read
  // calls (including repeats). We count raw occurrences in the path list
  // we'd build if we didn't dedup — simpler to re-scan.
  let isReRead = false;
  if (lastReadPath) {
    let count = 0;
    for (const msg of messages) {
      if (!_isAiMessage(msg)) continue;
      for (const tc of _getToolCalls(msg)) {
        if (
          READ_TOOL_NAMES.has(tc.name) &&
          _getPathFromArgs(tc.args) === lastReadPath
        ) {
          count++;
        }
      }
    }
    isReRead = count > 1;
  }

  return {
    uniquePaths: pathOrder,
    lastReadPath,
    hasActed,
    isReRead,
  };
}

// =============================================================================
// Hint construction
// =============================================================================

/**
 * Build the hint text for the current state, or `null` if no hint is needed.
 * Priority: re-read > budget exceeded.
 */
function _buildHint(analysis: ReadAnalysis): string | null {
  // 1. Re-read the same file — always warn (ZCode "Wasted call" pattern).
  if (analysis.isReRead && analysis.lastReadPath) {
    return (
      `[hint] You already read ${analysis.lastReadPath} earlier in this ` +
      `conversation. Refer to that earlier result instead of re-reading ` +
      `the unchanged file.`
    );
  }

  // 2. Read too many files without acting.
  const n = analysis.uniquePaths.length;
  if (n >= READ_BUDGET && !analysis.hasActed) {
    return (
      `[hint] You've read ${n} files without making any changes. Consider ` +
      `acting now based on what you know, or use grep_search for targeted ` +
      `lookups instead of reading more files.`
    );
  }

  return null;
}

// Marker used to detect idempotent re-append across turns.
const HINT_MARKER = "[hint]";

// =============================================================================
// Middleware
// =============================================================================

/**
 * Appends the hint to the system message content (string form only — the SDK's
 * `systemMessage.content` is a string in all Octopus configs).
 *
 * If the content already contains a `[hint]` line, the existing hint is
 * replaced (not duplicated) so the text stays stable across turns — important
 * for prompt-cache friendliness.
 */
function _appendHint(content: string, hint: string): string {
  // Remove any pre-existing hint block (from a prior turn in the same
  // model-call chain) to avoid stacking.
  const cleaned = content.replace(
    /\n*\[hint\][^\n]*(\n\[[^\]]*\][^\n]*)*$/,
    "",
  );
  return `${cleaned}\n\n${hint}`;
}

class ReadBudgetMiddleware {
  name = "ReadBudgetMiddleware";

  wrapModelCall = (
    request: {
      messages?: BaseMessage[];
      systemMessage?: any;
      [key: string]: unknown;
    },
    handler: (req: any) => any,
  ): any => {
    const messages = request.messages;
    if (!messages || messages.length === 0) {
      return handler(request);
    }

    const analysis = _analyzeReads(messages);
    const hint = _buildHint(analysis);
    if (!hint) return handler(request);

    const systemMessage = request.systemMessage;
    const content = systemMessage?.content;
    if (typeof content !== "string") {
      // Non-string content (content-block arrays) — skip hint injection
      // rather than risk malforming the blocks.
      logger.debug("System message content is not a string; skipping hint");
      return handler(request);
    }

    // Idempotent: if the exact hint is already present, don't re-append.
    if (content.includes(hint)) {
      return handler(request);
    }

    const newContent = _appendHint(content, hint);
    const newSystemMessage = Object.assign(
      Object.create(Object.getPrototypeOf(systemMessage)),
      systemMessage,
      { content: newContent },
    );

    logger.debug(
      `Injecting read-budget hint (uniqueFiles=${analysis.uniquePaths.length}, ` +
        `hasActed=${analysis.hasActed}, isReRead=${analysis.isReRead})`,
    );

    return handler({ ...request, systemMessage: newSystemMessage });
  };
}

export { ReadBudgetMiddleware };
