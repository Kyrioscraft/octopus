/**
 * Subagent orchestration middleware — makes the agent ACT LIKE an orchestrator.
 *
 * Problem: the main agent owns the search toolset (grep_search, execute). When
 * a user asks "find out how X works across the codebase", the shortest path for
 * the model is to search directly — so it does, and never delegates to Explore
 * subagents. Three factors reinforce this:
 * (a) The SDK's TASK_SYSTEM_PROMPT says "when NOT to use the task tool: if the
 *     task is trivial" — actively discouraging delegation.
 * (b) The SDK's default `task` tool description is a generic template with no
 *     explicit "When to use" trigger — the model doesn't recognize it as a
 *     delegation mechanism.
 * (c) Prompt-level guidance ("assess complexity, fan out to parallel Explore")
 *     lives in the middle of a long system prompt and gets drowned out.
 *
 * This middleware applies four interventions, all at runtime so they are the
 * LAST thing the model sees before generating (recency bias):
 *
 * 1. **Rewrite `task` tool description** (every call): replaces the SDK's
 *    generic template with a ZCode-style "Agent" description containing an
 *    explicit "When to use" section, parallel-launch guidance, and available
 *    agent types. Tool descriptions are what the model reads when selecting a
 *    tool — more influential than system-prompt guidance.
 *
 * 2. **Strip SDK's TASK_SYSTEM_PROMPT** (every call): removes the "When NOT to
 *    use" section that discourages delegation.
 *
 * 3. **Static orchestrator declaration** (every call): a short, imperative
 *    "YOU ARE AN ORCHESTRATOR" preamble appended to the system message.
 *
 * 4. **Dynamic delegation hint** (only when over-searching detected): when the
 *    agent has made ≥ SEARCH_BUDGET search calls without delegating, append a
 *    pointed reminder to delegate. Mirrors ReadBudgetMiddleware's pattern.
 *
 * Placed AFTER ReadBudgetMiddleware in the stack (agent.ts ~line 648) so it
 * has the final word on the system message content.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { getLogger } from "../logging.js";
import {
  readSystemMessageText,
  withSystemMessageText,
} from "./system_message_utils.js";

const logger = getLogger("middleware.subagent_orchestration");

// =============================================================================
// Constants
// =============================================================================

/**
 * Search-tool calls after which the dynamic delegation hint fires. Counts only
 * EXPLORATION tools — NOT read_file, because reading a known file to edit it
 * is normal and should NOT trigger the delegation nudge.
 *
 * After the ZCode-alignment refactor, the main agent's only search tools are
 * `execute` (Bash: rg/find) and `web_search`. The SDK's ls/glob/grep and the
 * ripgrep grep_search extension are all removed from the main agent's toolset.
 * `execute` is counted here because the model's primary search path is now
 * `rg`/`find` via execute — counting it catches the "agent greps inline
 * instead of delegating" pattern.
 */
const SEARCH_BUDGET = 2;

/** Tool names that count as "inline exploring" by the main agent. */
const SEARCH_TOOL_NAMES = new Set([
  "execute",
  "web_search",
]);

/** The `task` tool — evidence the agent IS orchestrating. */
const TASK_TOOL_NAME = "task";

// =============================================================================
// Static orchestrator declaration (appended every call)
// =============================================================================

/**
 * The mindset-reset preamble. Kept SHORT on purpose — long preambles get
 * ignored. Placed at the very end of the system message so recency bias makes
 * it the strongest signal. Constant text → prompt-cache friendly.
 */
const ORCHESTRATOR_DECLARATION = `
[orchestrator-mindset]
You are an ORCHESTRATOR. For any task involving codebase exploration, research, or "how does X work" questions: DELEGATE to the Explore subagent via the \`task\` tool — do NOT search inline yourself. Multiple independent questions? Launch parallel \`task\` calls in one response. Only search inline (via \`execute\`) for a single quick lookup you are confident about.`;

/** Sentinel used to detect an already-present declaration (idempotency). */
const DECLARATION_SENTINEL = "[orchestrator-mindset]";

// =============================================================================
// Dynamic delegation hint (appended only when over-searching detected)
// =============================================================================

/** Marker for the dynamic hint block (stripped each call to avoid stacking). */
const HINT_MARKER = "[delegation-hint]";

// =============================================================================
// `task` tool description override (ZCode-style "Agent" description)
// =============================================================================

/**
 * ZCode-style description for the `task` tool. The SDK's default description
 * is a generic template; this rewrite embeds an explicit "When to use" section,
 * parallel-launch guidance, and the available agent types — the same structure
 * that makes ZCode's `Agent` tool reliably trigger delegation.
 *
 * The tool NAME stays `task` (SDK hardcodes it and guards it via
 * BUILTIN_TOOL_NAMES), but the description is what the model reads when
 * deciding which tool to call — so this is where the behavior change happens.
 */
const TASK_TOOL_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
- Explore: Read-only search agent for broad fan-out searches — when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn't review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.
- general-purpose: Full-capability agent for complex multi-step tasks (search + write/edit/execute). Use for implementation work the main agent delegates.

When using the task tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

IMPORTANT: the \`description\` parameter IS the full task prompt — write a complete, self-contained instruction (goal, context, files/areas involved, what to report back), not a short label. The subagent receives it as its only input and starts with a fresh context.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.`;

/**
 * ZCode/opencode-style description for the `write_todos` tool. Four-section
 * structure (when to use / when NOT to use / rules / examples) with concrete
 * use-vs-skip pairs — proven far more reliable than abstract rules for
 * teaching models when to track tasks.
 */
const TODO_TOOL_DESCRIPTION = `Create and maintain a structured task list for the current session. Tracks progress, organizes multi-step work, and surfaces status to the user.

## When to use
- The task requires 3+ distinct steps or actions (not just 3 tool calls for one conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive mid-task — capture them as todos
- Start each task by marking exactly one \`in_progress\`; mark it \`completed\` as soon as it is actually done

## When NOT to use
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value

## Rules
- Update status in real time; don't batch completions
- Mark \`completed\` only after the work is actually done, including any required verification — never based on intent
- Keep exactly one \`in_progress\` while work remains
- If blocked or partial, keep it \`in_progress\` and add a follow-up todo describing the blocker
- Items should be specific and actionable; break large work into smaller steps

## Examples
Use it:
- "Add a dark mode toggle and run the tests" → multi-step feature + explicit verification
- "Rename getCwd -> getCurrentWorkingDirectory across the repo" → search reveals many occurrences across files
- "Implement registration, catalog, cart, checkout" → multiple complex features

Skip it:
- "How do I print Hello World in Python?" → informational
- "Add a comment to calculateTotal" → single edit
- "Run npm install and tell me what happened" → one command`;

// =============================================================================
// SDK TASK_SYSTEM_PROMPT stripping
// =============================================================================

/**
 * Marker for the SDK's `TASK_SYSTEM_PROMPT` block, injected by
 * `createSubAgentMiddleware` (runs before this middleware in the chain). The
 * block starts with `` ## `task` (subagent spawner) `` and contains a
 * "When NOT to use the task tool: If the task is trivial" section that
 * actively discourages delegation — the opposite of what we want.
 *
 * The SDK block is concatenated AFTER Octopus's system prompt, so we use
 * lastIndexOf to find it (mirroring stripFilesystemSystemPrompt's approach).
 * Octopus's own prompt does not contain this heading.
 */
const TASK_PROMPT_MARKER = "## `task` (subagent spawner)";

/**
 * Remove the SDK-injected TASK_SYSTEM_PROMPT from a system message content
 * string. Returns the content unchanged if the marker is not found.
 */
function stripTaskSystemPrompt(content: string): string {
  const idx = content.lastIndexOf(TASK_PROMPT_MARKER);
  if (idx === -1) return content;
  return content.slice(0, idx).replace(/\s+$/, "");
}

/**
 * Scan the conversation to count inline search calls vs. task delegations in
 * the current turn (most recent contiguous run of AI tool-calls).
 */
interface SearchProfile {
  /** Number of inline search-tool calls (grep/glob/ls/web_search/read_file). */
  searchCount: number;
  /** Whether the agent has used the `task` tool at all. */
  hasDelegated: boolean;
}

function _isAiMessage(msg: BaseMessage): boolean {
  return (msg as any).type === "ai" || (msg as any)._getType?.() === "ai";
}

function _getToolCalls(msg: BaseMessage): Array<{ name: string }> {
  const calls = (msg as any).tool_calls;
  return Array.isArray(calls) ? calls : [];
}

/**
 * Count exploration and task calls across the whole message history. We look
 * at the full history (not just the latest message) because a turn may span
 * multiple AI messages as the agent iterates.
 *
 * NOTE: `read_file` is deliberately NOT counted — reading a file you already
 * know about (e.g. before editing it) is not "exploring". Only tools that
 * SEARCH/DISCOVER (ls, glob, grep_search, web_search) count toward the budget.
 */
function _profileSearches(messages: BaseMessage[]): SearchProfile {
  let searchCount = 0;
  let hasDelegated = false;

  for (const msg of messages) {
    if (!_isAiMessage(msg)) continue;
    for (const tc of _getToolCalls(msg)) {
      if (SEARCH_TOOL_NAMES.has(tc.name)) {
        searchCount++;
      } else if (tc.name === TASK_TOOL_NAME) {
        hasDelegated = true;
      }
    }
  }

  return { searchCount, hasDelegated };
}

/**
 * Decide whether to emit the dynamic hint. We fire once the agent has done a
 * meaningful amount of inline searching, and KEEP firing on every subsequent
 * call (monotonic — searchCount only grows within a thread). The hint text is
 * CONSTANT (no searchCount interpolation): the system message sits at the very
 * head of the prompt, so any per-call change — a growing counter, or the hint
 * appearing/disappearing after the agent delegates — invalidates the ENTIRE
 * cached prefix (system + tools + history). A stable, threshold-triggered
 * block costs one cache miss when the threshold is first crossed and none
 * after that.
 */
function _shouldHint(profile: SearchProfile): boolean {
  return profile.searchCount >= SEARCH_BUDGET;
}

function _buildHint(): string {
  return (
    `${HINT_MARKER} Several direct search calls have been made without ` +
    `delegating to a subagent. If this task spans multiple areas or you're ` +
    `not finding what you need quickly, STOP searching inline and DELEGATE ` +
    `the remaining investigation to parallel Explore subagents via the ` +
    `\`task\` tool — launch one per independent target in a single response.`
  );
}

// =============================================================================
// System-message append helpers (mirror ReadBudgetMiddleware patterns)
// =============================================================================

/**
 * Append the static orchestrator declaration. Idempotent: if the sentinel is
 * already present, the content is returned unchanged (the declaration is
 * constant across calls, so this keeps the text stable for prompt caching).
 */
function _appendDeclaration(content: string): string {
  if (content.includes(DECLARATION_SENTINEL)) return content;
  return `${content.trimEnd()}\n${ORCHESTRATOR_DECLARATION}`;
}

/**
 * Append (or replace) the dynamic delegation hint. Strips any pre-existing
 * `[delegation-hint]` block first to avoid stacking across turns.
 */
function _appendHint(content: string, hint: string): string {
  const cleaned = content.replace(
    /\n*\[delegation-hint\][^\n]*(\n\[[^\]]*\][^\n]*)*$/,
    "",
  );
  return `${cleaned}\n\n${hint}`;
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Rewrites the `task` tool description to ZCode-style, strips the SDK's
 * TASK_SYSTEM_PROMPT from the system message, and appends orchestrator-mindset
 * guidance so the model treats delegation as its default strategy for
 * non-trivial investigations.
 *
 * Runs after ReadBudgetMiddleware in the chain (agent.ts). Handles both string
 * and content-block-array system message formats (see system_message_utils.ts).
 */
class SubagentOrchestrationMiddleware {
  name = "SubagentOrchestrationMiddleware";

  wrapModelCall = (
    request: {
      tools?: any[];
      messages?: BaseMessage[];
      systemMessage?: any;
      [key: string]: unknown;
    },
    handler: (req: any) => any,
  ): any => {
    // ---- 1. Rewrite the `task` + `write_todos` tool descriptions (ZCode-style) ----
    let tools = request.tools;
    if (tools) {
      for (const t of tools) {
        if (t?.name === "task" && t.description !== TASK_TOOL_DESCRIPTION) {
          t.description = TASK_TOOL_DESCRIPTION;
          logger.debug("Overrode task tool description (ZCode-style)");
        }
        if (t?.name === "write_todos" && t.description !== TODO_TOOL_DESCRIPTION) {
          t.description = TODO_TOOL_DESCRIPTION;
          logger.debug("Overrode write_todos tool description (ZCode-style)");
        }
      }
    }

    // ---- 2. Strip SDK's TASK_SYSTEM_PROMPT + append orchestrator guidance ----
    const systemMessage = request.systemMessage;
    const text = readSystemMessageText(systemMessage);
    if (!text) {
      return handler({ ...request, tools });
    }

    // Strip the SDK's TASK_SYSTEM_PROMPT first (it contains "When NOT to use
    // the task tool: if trivial" which actively discourages delegation).
    let newContent = stripTaskSystemPrompt(text);
    newContent = _appendDeclaration(newContent);

    // Dynamic hint — constant text, threshold-triggered (monotonic within a
    // thread; see _shouldHint). Never stripped once present: removing it after
    // the agent delegates would flip the system message again and invalidate
    // the whole cached prefix.
    const messages = request.messages;
    if (messages && messages.length > 0) {
      const profile = _profileSearches(messages);
      if (_shouldHint(profile)) {
        const hint = _buildHint();
        if (!newContent.includes(hint)) {
          newContent = _appendHint(newContent, hint);
          logger.debug(
            `Injecting delegation hint (searchCount=${profile.searchCount}, ` +
              `hasDelegated=${profile.hasDelegated})`,
          );
        }
      }
    }

    if (newContent === text) {
      return handler({ ...request, tools });
    }

    const newSystemMessage = withSystemMessageText(systemMessage, newContent);

    return handler({ ...request, tools, systemMessage: newSystemMessage });
  };
}

export { SubagentOrchestrationMiddleware };
