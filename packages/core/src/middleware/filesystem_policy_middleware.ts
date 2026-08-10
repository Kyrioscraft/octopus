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

const logger = getLogger("middleware.filesystem_policy");

// =============================================================================
// Tool description overrides — aligned with prompts.ts "prefer grep/glob".
// =============================================================================

const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  ls:
    "List files in a directory. Use SPARINGLY: prefer `grep_search`/`glob` " +
    "for codebase exploration. At most once at the very start to get a rough " +
    "layout; never use it to explore level-by-level. Requires an absolute path.",
  read_file:
    "Read a file from the filesystem. Prefer `grep_search` to locate symbols " +
    "first (it returns matches with context), then read targeted sections " +
    "with `offset`/`limit` for files >500 lines. Avoid reading entire large " +
    "files when you only need a specific section.",
  glob:
    "Find files matching a pattern (e.g. \"**/*.py\"). Preferred over `ls` " +
    "for any pattern-based or recursive lookup — one `glob` with a `**` " +
    "pattern replaces multiple `ls` calls.",
  grep:
    "Raw literal-only search (SDK; no regex, no context). Prefer the " +
    "`grep_search` tool, which supports full regex AND returns matching " +
    "lines with line numbers + context in one call — usually no follow-up " +
    "read_file needed. Use this only when `grep_search` is unavailable.",
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
 * `## Following Conventions` is the first heading of `FILESYSTEM_SYSTEM_PROMPT`
 * and is stable across SDK versions. `## Filesystem Tools` is a secondary
 * anchor used as a fallback.
 */
const FS_PROMPT_MARKERS = [
  "## Following Conventions",
  "## Filesystem Tools",
] as const;

/**
 * Remove the SDK-injected filesystem system prompt from a system message
 * content string. Returns the content unchanged if no marker is found.
 */
function stripFilesystemSystemPrompt(content: string): string {
  let earliest = -1;
  for (const marker of FS_PROMPT_MARKERS) {
    const idx = content.indexOf(marker);
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
 * Runs after `FilesystemMiddleware` in the chain.
 */
export class FilesystemPolicyMiddleware {
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
    let systemMessage = request.systemMessage;
    const content = systemMessage?.content;
    if (typeof content === "string") {
      const cleaned = stripFilesystemSystemPrompt(content);
      if (cleaned !== content) {
        // Create a new SystemMessage to avoid mutating the SDK's instance.
        systemMessage = Object.assign(
          Object.create(Object.getPrototypeOf(systemMessage)),
          systemMessage,
          { content: cleaned },
        );
        logger.debug("Stripped SDK FILESYSTEM_SYSTEM_PROMPT from system message");
      }
    }

    return handler({ ...request, tools, systemMessage });
  };
}
