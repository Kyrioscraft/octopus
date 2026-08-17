/**
 * Filesystem policy middleware.
 *
 * The deepagents SDK's `FilesystemMiddleware` appends its own
 * `FILESYSTEM_SYSTEM_PROMPT` and injects 6 filesystem tools (`ls`, `read_file`,
 * `write_file`, `edit_file`, `glob`, `grep`) on every model call. Combined with
 * Octopus's ripgrep `grep_search` extension, this creates 4+ overlapping search
 * tools — the model defaults to the most familiar (`ls`) and never delegates.
 *
 * This middleware (runs after the SDK's FS middleware — confirmed in SDK source
 * line ~5832) does three things to enforce ZCode's lean single-search-tool
 * architecture (where ALL search goes through Bash/execute):
 *
 * 1. **Removes `ls`/`glob`/`grep`/`grep_search`** from the toolset. Search is
 *    unified through `execute` (Bash: `rg`/`find`/`dir`). The model knows
 *    `rg`/`grep` from training data — no dedicated tool needed.
 * 2. **Rewrites `read_file`/`execute` descriptions** so the surviving tools
 *    carry the right guidance (e.g. `execute`'s SDK description says "avoid
 *    find/grep" — directly contradicting the unified-search model).
 * 3. **Strips SDK-injected prompts** (`BASE_AGENT_PROMPT`,
 *    `FILESYSTEM_SYSTEM_PROMPT`) from the system message. The SDK has no option
 *    to suppress these; they bloat the system message with duplicate sections
 *    and reference tools we just removed.
 */

import { getLogger } from "../logging.js";
import {
  readSystemMessageText,
  withSystemMessageText,
} from "./system_message_utils.js";

const logger = getLogger("middleware.filesystem_policy");

// =============================================================================
// Tool description overrides.
//
// The SDK's ls/glob/grep tools are REMOVED from the toolset at runtime (see
// SDK_SEARCH_TOOLS below) to avoid overlap with `execute` — matching ZCode's
// single-search-entry architecture (all search via Bash). So we only need
// description overrides for tools that SURVIVE: read_file and execute.
// =============================================================================

const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  read_file:
    "Read a file from the filesystem. Use offset/limit for files >500 lines.",
  execute:
    "Executes a bash command and returns its output. Use this for codebase " +
    "search (rg for content search, find/dir for file lookup), running tests, " +
    "builds, git operations, and any shell task.\n" +
    "- For codebase content search: `rg PATTERN` with -n (line numbers), " +
    "-C (context), -i (case-insensitive), --glob (file filter). Example: " +
    "`rg -n -C 3 \"function\\s+\\w+\" --glob \"*.ts\"`\n" +
    "- For finding files: `find . -name \"*.py\"` or `dir /s /b *.py` on Windows\n" +
    "- Prefer absolute paths; shell state (env vars, functions) does not persist.\n" +
    "- For reading files, prefer `read_file` over cat/head/tail. For editing, " +
    "prefer `edit_file` over sed/awk. For writing new files, prefer " +
    "`write_file` over echo/heredoc.\n" +
    "- timeout is in milliseconds (default 120000, max 600000).",
};

/**
 * SDK-injected search tools that are REMOVED from the toolset to enforce a
 * single search architecture (matching ZCode, where ALL search goes through
 * Bash/execute):
 *   - `ls`          → superseded by `execute` (run `ls`/`find`/`dir` via Bash)
 *   - `glob`        → superseded by `execute` (`find`/`dir` via Bash)
 *   - `grep`        → superseded by `execute` (`rg`/`grep` via Bash)
 *   - `grep_search` → superseded by `execute` (`rg` via Bash)
 *
 * ZCode has NO dedicated search tool — all codebase search is done via the
 * Bash tool running `rg`/`find`/`grep`. This eliminates tool overlap and
 * forces the model to use `execute` (which it knows well from training data)
 * or delegate to Explore subagents, rather than defaulting to the most
 * familiar SDK tool (`ls`).
 *
 * NOTE: `grep_search` is still injected by the server (ripgrep extension) and
 * is available to the Explore SUBAGENT (which has its own isolated toolset via
 * READONLY_TOOL_NAMES). Only the MAIN agent's toolset has it filtered out.
 */
const SDK_SEARCH_TOOLS = new Set(["ls", "glob", "grep", "grep_search"]);

// =============================================================================
// FILESYSTEM_SYSTEM_PROMPT stripping.
// =============================================================================

/**
 * Marker that marks the start of the SDK's `FILESYSTEM_SYSTEM_PROMPT`
 * (and `EXECUTION_SYSTEM_PROMPT`) block appended by `FilesystemMiddleware`.
 * The SDK uses `systemMessage.concat(filesystemPrompt)` so the injected text
 * appears at the end of the system message content.
 *
 * `## Following Conventions` is the first heading of `FILESYSTEM_SYSTEM_PROMPT`.
 * `## Filesystem Tools` is a unique heading that appears ONLY in the SDK
 * block (octopus's own prompt does not contain it) — used as a reliable anchor.
 *
 * IMPORTANT: `## Following Conventions` ALSO appears in octopus's own system
 * prompt (prompts.ts). Because the SDK block is concatenated AFTER octopus's
 * prompt, we search for the LAST occurrence (lastIndexOf) and take the earliest
 * cut point among all markers. Using indexOf here was a critical bug — it
 * matched octopus's own section and truncated the entire prompt from that
 * point, deleting Tool Usage, Subagent Delegation, etc.
 */
const FS_PROMPT_MARKERS = [
  "## Following Conventions",
  "## Filesystem Tools",
] as const;

/**
 * Remove the SDK-injected filesystem system prompt from a system message
 * content string. The SDK block is always at the END of the content (concat'd
 * by FilesystemMiddleware), so we search from the end with lastIndexOf.
 * Returns the content unchanged if no marker is found.
 */
function stripFilesystemSystemPrompt(content: string): string {
  let earliest = -1;
  for (const marker of FS_PROMPT_MARKERS) {
    // lastIndexOf finds the SDK block's marker (at the end), not octopus's
    // own earlier occurrence of the same heading (e.g. ## Following Conventions
    // appears in both — only the last one is the SDK injection).
    const idx = content.lastIndexOf(marker);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  if (earliest === -1) return content;
  // Trim trailing whitespace/newlines left behind at the cut point.
  return content.slice(0, earliest).replace(/\s+$/, "");
}

// =============================================================================
// SDK BASE_AGENT_PROMPT stripping.
// =============================================================================

/**
 * Marker for the SDK's `BASE_AGENT_PROMPT`, which `createDeepAgent`
 * UNCONDITIONALLY appends to the caller's systemPrompt as a second text block
 * (langsmith-wdF8zG42.js ~line 5878). This creates duplicate sections —
 * `## Core Behavior`, `## Doing Tasks`, etc. — that already exist in Octopus's
 * own prompt, bloating the system message and confusing the model.
 *
 * The marker `You are a Deep Agent` is the opening line of BASE_AGENT_PROMPT
 * and is unique (Octopus's own prompt uses lowercase `deep agent`). It appears
 * AFTER Octopus's prompt but BEFORE the runtime SDK prompts
 * (FILESYSTEM_SYSTEM_PROMPT, TASK_SYSTEM_PROMPT), which are stripped by their
 * own functions.
 *
 * All three SDK prompt injections are stripped here in a single pass, leaving
 * only Octopus's own system prompt + the orchestrator-mindset declaration
 * appended by SubagentOrchestrationMiddleware.
 */
const BASE_AGENT_PROMPT_MARKER = "You are a Deep Agent";

/**
 * Remove the SDK's BASE_AGENT_PROMPT from a system message content string.
 * Returns the content unchanged if the marker is not found.
 */
function stripBaseAgentPrompt(content: string): string {
  const idx = content.indexOf(BASE_AGENT_PROMPT_MARKER);
  if (idx === -1) return content;
  return content.slice(0, idx).replace(/\s+$/, "");
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Rewrites filesystem tool descriptions and strips the SDK's
 * `FILESYSTEM_SYSTEM_PROMPT` from the system message so that Octopus's own
 * guidance ("prefer grep/glob over ls") is the last word the model sees.
 *
 * Runs after `FilesystemMiddleware` in the chain. Handles both string and
 * content-block-array system message formats (the array form is the default
 * in @langchain/core v1 — see system_message_utils.ts for details).
 */
export class FilesystemPolicyMiddleware {
  name = "FilesystemPolicyMiddleware";

  wrapModelCall = (
    request: {
      tools?: any[];
      systemMessage?: any;
      [key: string]: unknown;
    },
    handler: (req: any) => any,
  ): any => {
    // ---- 1. Remove SDK search tools (ls/glob/grep/grep_search) — unified
    //         search via execute (Bash: rg/find/dir). See SDK_SEARCH_TOOLS.
    let tools = request.tools;
    if (tools && tools.length > 0) {
      const before = tools.length;
      tools = tools.filter((t: any) => !SDK_SEARCH_TOOLS.has(t?.name));
      if (tools.length !== before) {
        logger.debug(
          `Removed ${before - tools.length} search tool(s) ` +
            "(ls/glob/grep/grep_search) — unified search via execute",
        );
      }
    }

    // ---- 2. Rewrite surviving tool descriptions ----
    if (tools) {
      let changed = false;
      for (const t of tools) {
        const override = TOOL_DESCRIPTION_OVERRIDES[t?.name];
        if (override && t.description !== override) {
          // `description` is a public mutable string on DynamicStructuredTool.
          t.description = override;
          changed = true;
        }
      }
      if (changed) {
        logger.debug("Overrode filesystem tool descriptions");
      }
    }

    // ---- 3. Strip SDK-injected prompts from system message ----
    // The SDK appends THREE prompt blocks that bloat/confuse the system message:
    //   a) BASE_AGENT_PROMPT (build-time) — duplicates Octopus's ## Core Behavior /
    //      ## Doing Tasks sections (SDK has no option to suppress it).
    //   b) FILESYSTEM_SYSTEM_PROMPT (runtime, by fsMiddleware) — lists removed
    //      tools (ls/glob/grep) and omits execute entirely.
    //   c) EXECUTION_SYSTEM_PROMPT (runtime, by fsMiddleware) — appended right
    //      after (b), stripped by the same marker cut.
    // TASK_SYSTEM_PROMPT (runtime, by subagentMiddleware) is stripped separately
    // by SubagentOrchestrationMiddleware.
    let systemMessage = request.systemMessage;
    const text = readSystemMessageText(systemMessage);
    if (text) {
      let cleaned = stripBaseAgentPrompt(text);
      cleaned = stripFilesystemSystemPrompt(cleaned);
      if (cleaned !== text) {
        systemMessage = withSystemMessageText(systemMessage, cleaned);
        logger.debug(
          "Stripped SDK BASE_AGENT_PROMPT + FILESYSTEM_SYSTEM_PROMPT " +
            `(${text.length} → ${cleaned.length} chars)`,
        );
      }
    }

    return handler({ ...request, tools, systemMessage });
  };
}
