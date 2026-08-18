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

import { z } from "zod";
import { getLogger } from "../logging.js";
import { resolveBash } from "../shell.js";
import { tmpdir } from "node:os";
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
//
// Description style borrowed from opencode: shell-specific guidance, output-
// truncation policy, temp-dir pre-approval, and clear division of labor vs
// the file tools. All of this lives in the TOOL DESCRIPTION (not the system
// prompt) because tool descriptions are what the model reads when deciding
// how to use a tool.
// =============================================================================

/**
 * Shell-specific guidance block for `execute`. Branches on the ACTUAL shell
 * used by BashShellBackend: on Windows, commands run through Git Bash
 * (`bash -c`) when one is available (resolveBash, see shell.ts), otherwise
 * cmd.exe — the model must be told the truth so it doesn't hedge into
 * `cmd /c findstr` fallbacks or invalid Unix syntax.
 */
function _shellGuidance(): string {
  const relativePathRules =
    "- Path arguments in search commands (rg/grep/find/findstr) must be RELATIVE " +
    "paths — the working directory is already the workspace root (see " +
    "<system-reminder>). NEVER hand-construct absolute paths for search; " +
    "duplicated or misspelled root segments make the path invalid.\n" +
    "- If a command reports a missing path, run a quick `ls` to confirm the " +
    "directory structure BEFORE retrying — do not blindly re-guess paths.";
  if (process.platform === "win32") {
    if (resolveBash()) {
      return (
        "# Shell notes (Git Bash on Windows)\n" +
        "- Unix syntax works: pipes (`grep -rn \"pattern\" src | head -20`), " +
        "`find`, `ls`, `&&`/`;` chaining\n" +
        "- Quote paths containing spaces with double quotes\n" +
        "- Prefer forward slashes in paths\n" +
        "- Use `node:` protocol for Node built-ins; run `node script.mjs` for JS snippets\n" +
        relativePathRules
      );
    }
    return (
      "# Shell notes (cmd.exe on Windows — no bash available)\n" +
      "- NO Unix pipes or grep/find syntax. Content search: " +
      "`findstr /s /i /n \"pattern\" src\\*.ts`; file lookup: `dir /s /b *.ts`\n" +
      "- Chain dependent commands with `&&`; variables use `%VAR%` syntax\n" +
      relativePathRules
    );
  }
  return (
    "# Shell notes (bash)\n" +
    "- Chain dependent commands with `&&`; use `;` only when failure of the first is acceptable\n" +
    "- Quote paths containing spaces with double quotes\n" +
    "- Use `node:` protocol for Node built-ins; run `node script.mjs` for JS snippets\n" +
    relativePathRules
  );
}

/**
 * Build the `execute` tool description. Assembled as a function (rather than a
 * static string) so the shell guidance and temp dir reflect the actual
 * runtime platform.
 */
function _buildExecuteDescription(): string {
  return (
    "Executes a shell command and returns its output. Use this for codebase " +
    "search (rg for content search, find/dir for file lookup), running tests, " +
    "builds, git operations, and any shell task.\n\n" +
    "IMPORTANT: Do NOT use this tool for file operations — avoid `cat`, `head`, " +
    "`tail`, `sed`, `awk`, `echo >` for reading/writing/editing files. Use " +
    "read_file / write_file / edit_file instead. This tool is for terminal " +
    "operations: git, npm, tests, builds, search.\n\n" +
    "For temporary work outside the workspace, use `" +
    tmpdir().replace(/\\/g, "/") +
    "` — it already exists and is pre-approved.\n\n" +
    _shellGuidance() +
    "\n\n" +
    "# Search\n" +
    "- Content search: `rg PATTERN` with -n (line numbers), -C (context), " +
    "-i (case-insensitive), --glob (file filter). Example: " +
    "`rg -n -C 3 \"function\\s+\\w+\" --glob \"*.ts\"`\n" +
    "- File lookup: `find . -name \"*.py\"` (or `dir /s /b *.py` on Windows)\n\n" +
    "# Output handling\n" +
    "- Output exceeding ~100KB is truncated and the excess is DISCARDED (a truncation notice is appended). If you need the full output, re-run the command redirecting to a temp file (`cmd > \"" +
    tmpdir().replace(/\\/g, "/") +
    "/out.txt\"`), then page through it with `read_file`.\n" +
    "- Keep output small by design: `rg --max-count 20`, `git diff --stat` before full diffs, non-recursive `ls` first.\n\n" +
    "# Other\n" +
    "- Use RELATIVE paths (cwd is the workspace root); avoid `cd` in compound " +
    "commands. Shell state (env vars, functions) does not persist between calls.\n" +
    "- Commands time out after 120 seconds (fixed server-side, not a parameter). Long-running commands are killed — split the work or run in background writing to a file."
  );
}

/**
 * Build the `read_file` tool description (opencode-style: line format,
 * default depth, parallel reads, oversized-line truncation).
 */
function _buildReadFileDescription(): string {
  return (
    "Read a file or directory from the filesystem.\n" +
    "- file_path is the only required parameter; omit offset/limit to read the whole file (default 2000 lines)\n" +
    "- offset (0-indexed line number) + limit to read a later section of a large file\n" +
    "- Reading a directory returns its entries one per line (dirs get a trailing /)\n" +
    "- When you need multiple files, issue parallel read_file calls in ONE response\n" +
    "- Avoid tiny repeated slices (30-line chunks) — read a larger window instead"
  );
}

const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  read_file: _buildReadFileDescription(),
  execute: _buildExecuteDescription(),
};

/**
 * Replacement schema for `read_file`. The SDK's original marks offset/limit
 * required (via .default()) with limit defaulting to 100 — the model is forced
 * to pass both on every call and reads fragment into 100-line chunks. This
 * schema: only `file_path` required, `offset` optional (0-indexed line),
 * `limit` optional defaulting to 2000 (full-file reads by default).
 */
const READ_FILE_SCHEMA = z
  .object({
    file_path: z
      .string()
      .describe("Absolute path to the file (or directory) to read"),
    offset: z
      .coerce.number()
      .optional()
      .describe(
        "Line offset to start reading from (0-indexed). Omit to read from the start.",
      ),
    limit: z
      .coerce.number()
      .optional()
      .describe(
        "Maximum number of lines to read. Omit to read the whole file (default 2000).",
      ),
  })
  .describe("Read a file or directory from the filesystem");

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

    // ---- 2.5 Override read_file schema ----
    // The SDK's read_file marks offset/limit as REQUIRED (via .default()) and
    // defaults limit to 100 — forcing the model to pass offset+limit on every
    // call and fragmenting reads into 100-line chunks. Rebuild the schema:
    // only file_path required, limit optional defaulting to 2000, matching
    // the description above. `schema` is a public mutable field on
    // DynamicStructuredTool (same as `description`).
    if (tools) {
      for (const t of tools) {
        if (t?.name === "read_file") {
          t.schema = READ_FILE_SCHEMA;
          break;
        }
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
