/**
 * Filesystem policy middleware.
 *
 * The deepagents SDK's `FilesystemMiddleware` appends its own
 * `FILESYSTEM_SYSTEM_PROMPT` and tool descriptions to every model call,
 * *after* Octopus's system prompt. Two of those injected texts directly
 * contradict Octopus's guidance:
 *
 * - `LS_TOOL_DESCRIPTION` says "almost ALWAYS use this tool before
 *   read_file" — conflicts with Octopus's "prefer grep/glob, ls at most once".
 * - `FILESYSTEM_SYSTEM_PROMPT` lists the FS tools with naive descriptions.
 *
 * Because the SDK's text appears last in the system message (recency bias),
 * the model follows it — causing repeated `ls` calls during exploration.
 *
 * `createDeepAgent` does not expose `customToolDescriptions` / filesystem
 * options, so we cannot suppress the injection at the source. Instead, this
 * middleware runs *after* the FS middleware (SDK places `customMiddleware`
 * after `fsMiddleware` in the chain — confirmed in SDK source line ~5832)
 * and rewrites the conflicting content right before it reaches the model.
 *
 * Mechanism mirrors what the FS middleware itself does
 * (`request.tools` read-filter-replace, `systemMessage.concat`).
 */

import { getLogger } from "../logging.js";
import {
  readSystemMessageText,
  withSystemMessageText,
} from "./system_message_utils.js";

const logger = getLogger("middleware.filesystem_policy");

// =============================================================================
// Tool description overrides — aligned with prompts.ts "prefer grep/glob".
// =============================================================================

const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  ls:
    "List files in a directory. Use SPARINGLY: prefer `grep_search`/`glob` " +
    "for codebase exploration. At most once at the very start to get a rough " +
    "layout; never use it to explore level-by-level. For BROAD exploration " +
    "(understanding a codebase, multi-file research), delegate to the Explore " +
    "subagent via the `task` tool instead of calling this yourself. " +
    "Requires an absolute path.",
  read_file:
    "Read a file from the filesystem. Prefer `grep_search` to locate symbols " +
    "first (it returns matches with context), then read targeted sections " +
    "with `offset`/`limit` for files >500 lines. Avoid reading entire large " +
    "files when you only need a specific section.",
  glob:
    "Find files matching a pattern (e.g. \"**/*.py\"). Preferred over `ls` " +
    "for any pattern-based or recursive lookup — one `glob` with a `**` " +
    "pattern replaces multiple `ls` calls. For BROAD multi-area codebase " +
    "exploration, delegate to the Explore subagent via `task` instead of " +
    "chaining multiple glob calls yourself.",
  grep:
    "Raw literal-only search (SDK; no regex, no context). Prefer the " +
    "`grep_search` tool, which supports full regex AND returns matching " +
    "lines with line numbers + context in one call — usually no follow-up " +
    "read_file needed. Use this only when `grep_search` is unavailable.",
  grep_search:
    "基于 ripgrep 的内容搜索（首选搜索工具）。一次调用返回匹配行+行号+上下文，" +
    "支持完整正则，通常无需再调 read_file。用 include/exclude 限定文件类型；" +
    "用 context 读取匹配处周围代码。对于跨多区域的大型代码库调研（如\"X 是怎么" +
    "实现的\"\"找到所有相关文件\"），应委派给 Explore 子智能体（task 工具）并行" +
    "搜索，而不是自己串行调用本工具多次。",
};

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
    // ---- 1. Rewrite tool descriptions ----
    let tools = request.tools;
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

    // ---- 2. Strip SDK's FILESYSTEM_SYSTEM_PROMPT from system message ----
    // The SDK's FILESYSTEM_SYSTEM_PROMPT lists only 6 FS tools (ls, read_file,
    // write_file, edit_file, glob, grep) and omits grep_search entirely. If it
    // leaks through, the model believes it has no grep_search tool. Stripping
    // it here is what makes grep_search actually get used.
    let systemMessage = request.systemMessage;
    const text = readSystemMessageText(systemMessage);
    if (text) {
      const cleaned = stripFilesystemSystemPrompt(text);
      if (cleaned !== text) {
        systemMessage = withSystemMessageText(systemMessage, cleaned);
        logger.debug("Stripped SDK FILESYSTEM_SYSTEM_PROMPT from system message");
      }
    }

    return handler({ ...request, tools, systemMessage });
  };
}
