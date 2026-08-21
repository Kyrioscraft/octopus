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
 * in the stack (agent.ts ~line 640).
 *
 * ## Cache strategy (v2 — tool-result append)
 *
 * The hint is appended to the read tool's OWN result (a new ToolMessage at the
 * conversation tail, persisted in the checkpoint). An earlier version
 * prepended the hint to the last HumanMessage from wrapModelCall — but that
 * message sits mid-history once tool results follow it, the injection never
 * persisted to the checkpoint, and the hint text varied per call (file
 * counts/paths), so every model call rewrote the cached prefix mid-stream and
 * cache hit collapsed to ~1%. Tail-appends to new messages never rewrite
 * history — see filesystem_empty_result.ts for the same pattern.
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";
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

/**
 * Append the hint to the tool result (a NEW ToolMessage at the tail of the
 * conversation). Tail-only appends are prompt-cache friendly: they never
 * rewrite history, and the ToolMessage persists in the checkpoint, so the
 * hint stays visible on every subsequent call without re-derivation.
 */
function _appendHintToResult(result: any, hint: string): any {
  if (!(result instanceof ToolMessage)) return result;
  const content = result.content;
  if (typeof content === "string") {
    result.content = `${content}\n\n${hint}`;
  } else if (Array.isArray(content)) {
    const last = content[content.length - 1];
    if (last && typeof last === "object" && last.type === "text" && typeof last.text === "string") {
      last.text = `${last.text}\n\n${hint}`;
    } else {
      content.push({ type: "text", text: hint });
    }
  }
  return result;
}

// =============================================================================
// Middleware
// =============================================================================

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

class ReadBudgetMiddleware {
  name = "ReadBudgetMiddleware";

  wrapToolCall = (
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => any,
  ): any => {
    const outcome = handler(request);
    if (!(outcome instanceof Promise)) {
      return this._maybeHint(request, outcome);
    }
    return outcome.then((r) => this._maybeHint(request, r));
  };

  private _maybeHint = (request: ToolCallRequest, result: any): any => {
    const name = request.toolCall?.name;
    if (!name || !READ_TOOL_NAMES.has(name)) return result;
    if (!(result instanceof ToolMessage)) return result;

    // Scan the conversation history (state.messages) for the read/act picture
    // INCLUDING the in-flight read call. The hint lands in the tool result —
    // a new tail message that persists in the checkpoint — so the text may
    // freely include counts/paths without ever rewriting cached history.
    const state = (request.state ?? {}) as Record<string, unknown>;
    const history = Array.isArray(state["messages"])
      ? (state["messages"] as BaseMessage[])
      : [];

    // Include the in-flight call so re-read detection sees it.
    const inflight: BaseMessage = new AIMessage({
      content: "",
      tool_calls: [request.toolCall as any],
    });
    const analysis = _analyzeReads([...history, inflight]);
    const hint = _buildHint(analysis);
    if (!hint) return result;

    logger.debug(
      `Appending read-budget hint to ${name} result ` +
        `(uniqueFiles=${analysis.uniquePaths.length}, ` +
        `hasActed=${analysis.hasActed}, isReRead=${analysis.isReRead})`,
    );
    return _appendHintToResult(result, hint);
  };
}

export { ReadBudgetMiddleware };
