/**
 * Intercept `execute` (shell) tool calls that perform file write/edit
 * operations and redirect the model to the dedicated `edit_file` /
 * `write_file` tools instead.
 *
 * The system prompt already says "use edit_file over sed/awk, write_file over
 * echo/heredoc" — but non-Anthropic models (deepseek, qwen, glm, etc.) often
 * ignore that guidance and reach for shell commands like `sed -i`, `echo >`,
 * `cat >`, or `tee`. Each such `execute` call triggers a HITL approval
 * interrupt, flooding the user with approval prompts and defeating the
 * purpose of having dedicated file tools.
 *
 * This middleware inspects the `command` string of every `execute` call.
 * When it detects a file-write/edit pattern, it returns an error ToolMessage
 * (without executing the command) telling the model to use `edit_file` or
 * `write_file` instead. Legitimate shell usage (running tests, installing
 * deps, `git diff`, `ls`, etc.) is left untouched.
 *
 * Pattern detection is intentionally conservative — only clear file-write
 * indicators are matched to avoid false positives on commands that merely
 * *read* files or use redirection for piping between commands.
 */

import { ToolMessage } from "@langchain/core/messages";

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

/**
 * Patterns that strongly indicate a file-write or file-edit operation.
 * Each entry is a regex tested against the raw command string.
 */
const FILE_WRITE_PATTERNS: ReadonlyArray<{ re: RegExp; tool: string; reason: string }> = [
  // sed --in-place / sed -i  (in-place edit)
  { re: /\bsed\b[^|]*\s-i\b/, tool: "edit_file", reason: "sed -i performs in-place file editing" },
  // echo "..." > file   /   echo '...' >> file   (redirect to file)
  { re: /\becho\b[^|]*\s>+/, tool: "write_file", reason: "echo with output redirection writes to a file" },
  // printf "..." > file  / printf ... >> file
  { re: /\bprintf\b[^|]*\s>+/, tool: "write_file", reason: "printf with output redirection writes to a file" },
  // cat > file   /   cat >> file   (heredoc-style write, NOT cat file | ...)
  // Match "cat" followed by ">" or ">>" before any pipe
  { re: /\bcat\b[^|]*\s>+/, tool: "write_file", reason: "cat with output redirection writes to a file" },
  // tee file   /   tee -a file   (write stdin to file)
  // Only match when tee appears to be the write target, not in a pipeline reading FROM a file
  { re: /\btee\b(?:\s+-a)?\s+[^|&<]+$/, tool: "write_file", reason: "tee writes to a file" },
  // perl -i -pe  (in-place edit)
  { re: /\bperl\b[^|]*\s-i\b/, tool: "edit_file", reason: "perl -i performs in-place file editing" },
  // python -c "with open(...) as f: f.write(...)"  (write mode)
  { re: /\bpython3?\b[^|]*-c\b[^|]*open\s*\([^)]*\s*[\"']w/, tool: "write_file", reason: "python open(...,'w') writes to a file" },
  // dd of=file  (disk dump to file)
  { re: /\bdd\b[^|]*\bof=/, tool: "write_file", reason: "dd of= writes to a file" },
  // > file  at the very start of the command (bare redirect, e.g. "> file.txt")
  { re: /^\s*>+/, tool: "write_file", reason: "output redirection writes to a file" },
  // truncate -s 0 file  (clear file contents)
  { re: /\btruncate\b/, tool: "write_file", reason: "truncate modifies file contents" },
];

/**
 * Detect whether a shell command performs a file write/edit operation.
 * Returns the recommended tool name + human-readable reason, or null if
 * the command looks safe (read-only / unrelated).
 */
function detectFileWrite(
  command: string,
): { tool: string; reason: string } | null {
  if (!command || typeof command !== "string") return null;
  for (const { re, tool, reason } of FILE_WRITE_PATTERNS) {
    if (re.test(command)) return { tool, reason };
  }
  return null;
}

/**
 * Constructor options.
 *
 * `bypassWhenFull` disables the guard entirely. It is set when the graph is
 * built for `full` access mode, where the user has explicitly opted into a
 * fully autonomous agent (including shell commands that write files). In all
 * other modes (plan/confirm/auto) the guard stays active so non-Anthropic
 * models are still redirected toward `edit_file` / `write_file`.
 */
interface FileEditGuardOptions {
  bypassWhenFull?: boolean;
}

class FileEditGuardMiddleware {
  name = "FileEditGuardMiddleware";

  private readonly _bypassWhenFull: boolean;

  constructor(options: FileEditGuardOptions = {}) {
    this._bypassWhenFull = options.bypassWhenFull === true;
  }

  private _intercept = (request: ToolCallRequest): ToolMessage | undefined => {
    // In `full` mode the guard is bypassed — the user has accepted that the
    // agent may run any shell command, including file-writing ones.
    if (this._bypassWhenFull) return undefined;

    const toolCall = request.toolCall;
    if (toolCall.name !== "execute") return undefined;

    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const command = (args["command"] as string) || "";
    const detected = detectFileWrite(command);
    if (!detected) return undefined;

    const tool = detected.tool;
    return new ToolMessage({
      content:
        `This shell command was NOT executed because it performs a file ` +
        `write/edit operation (${detected.reason}). ` +
        `Use the \`${tool}\` tool instead — it is safer, provides proper ` +
        `error handling, and is the project convention. ` +
        `If you need to create a new file, use \`write_file\`; ` +
        `if you need to modify an existing file, first \`read_file\` to see ` +
        `its contents, then \`edit_file\` with the exact old_string to replace.`,
      name: "execute",
      tool_call_id: toolCall.id ?? "",
      status: "error",
    });
  };

  wrapToolCall = (
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => any,
  ): any => {
    const rejection = this._intercept(request);
    if (rejection) return rejection;
    return handler(request);
  };
}

export { FileEditGuardMiddleware, detectFileWrite };
