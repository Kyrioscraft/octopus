/**
 * Bundled ripgrep search tool — a high-priority `grep_search` tool that
 * returns matching lines WITH line numbers and optional context in a single
 * call, so the model usually does NOT need a follow-up read_file.
 *
 * This is the extension entry point. The server imports `createRipgrepTool`
 * and injects the resulting StructuredTool into core's makeGraph via the
 * `externalTools` option.
 *
 * Design rationale (discovered from analyzing a reference agent's bundle):
 * that agent's "few tool calls when reading files" comes from its Grep tool
 * being powerful enough to return content + context in one shot (ripgrep with
 * -n/-A/-B/-C), NOT from a compound tool. Octopus's SDK grep only returns a
 * single bare line with no context and no regex, forcing a grep→read_file
 * chain. This tool closes that gap.
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { runRipgrep } from "./ripgrep.js";
import { getLogger } from "@octopus/core";

const logger = getLogger("extension.ripgrep.tool");

const GrepSearchSchema = z.object({
  pattern: z
    .string()
    .describe(
      "正则表达式（完整 ripgrep 语法）。例如 \"log.*Error\"、\"function\\s+\\w+\"。" +
      "转义字面量大括号（`interface\\{\\}`）。不是 glob —— 文件过滤请用 include。",
    ),
  path: z
    .string()
    .optional()
    .describe("搜索的文件或目录（绝对路径）。省略则搜索当前工作目录。"),
  include: z
    .string()
    .optional()
    .describe('文件 glob 过滤，如 "*.ts"、"*.{ts,tsx}"。映射到 rg --glob。'),
  exclude: z
    .string()
    .optional()
    .describe('排除 glob，如 "**/node_modules/**"。映射到 rg --glob "!..."。'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      '"content" = 匹配行+行号+上下文（默认，通常无需再 read_file）；' +
      '"files_with_matches" = 仅文件路径；"count" = 匹配计数。',
    ),
  context: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "每条匹配前后显示的上下文行数（rg -C）。仅 content 模式生效。" +
      "默认 0；设 3-5 可直接看到周围代码，省去后续 read_file。",
    ),
  case_insensitive: z
    .boolean()
    .optional()
    .describe("大小写不敏感搜索（rg -i）。"),
  max_results: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("返回的匹配上限（防止上下文溢出）。默认 50。"),
}).describe("");

/**
 * Create the `grep_search` tool instance.
 *
 * @param cwd The working directory ripgrep runs in when `path` is omitted.
 *            The server passes the agent's resolved cwd here.
 */
export function createRipgrepTool(cwd: string) {
  return tool(
    async (input) => {
      const mode = input.output_mode ?? "content";
      const maxResults = input.max_results ?? 50;

      // Build ripgrep args. --line-number and --color=never are always on so
      // content output is directly usable (line-prefixed, no ANSI).
      const args: string[] = [
        "--line-number",
        "--color=never",
        `--max-count=${maxResults}`,
      ];
      if (input.case_insensitive) args.push("-i");
      if (mode === "files_with_matches") args.push("--files-with-matches");
      else if (mode === "count") args.push("--count");
      // content mode is the default; context only applies there.
      if (mode === "content" && input.context && input.context > 0) {
        args.push("-C", String(input.context));
      }
      if (input.include) args.push("--glob", input.include);
      if (input.exclude) args.push("--glob", `!${input.exclude}`);

      // `--` separates ripgrep flags from the positional pattern and path.
      // `pattern` is required by the schema (z.string(), not optional), but
      // LangChain's `tool()` infers the handler input loosely — the `!`
      // asserts the schema guarantee to TypeScript.
      args.push("--", input.pattern!, input.path ?? ".");

      // cwd is only relevant when no explicit path is given; when input.path
      // is set, ripgrep searches that path directly. Coalesce to satisfy the
      // string parameter type.
      const result = runRipgrep(args, input.path ? input.path : cwd);

      if (result.timedOut) {
        return JSON.stringify({
          error: "ripgrep timed out (search may be too broad — add include/exclude)",
          pattern: input.pattern,
        });
      }
      // exitCode 2 = ripgrep error (bad regex, bad path, etc.)
      if (result.exitCode === 2) {
        logger.warn(`ripgrep error (exit 2): ${result.stderr}`);
        return JSON.stringify({
          error: result.stderr || "ripgrep error",
          pattern: input.pattern,
        });
      }
      // exitCode 0 = matches, 1 = no matches — both are normal.
      const trimmed =
        result.stdout.length > 200_000
          ? result.stdout.slice(0, 200_000) + "\n...[truncated]"
          : result.stdout;

      return JSON.stringify({
        pattern: input.pattern,
        output_mode: mode,
        has_matches: result.exitCode === 0,
        output: trimmed || "(no matches)",
      });
    },
    {
      name: "grep_search",
      description:
        "基于内置 ripgrep 的内容搜索（最高优先级搜索工具）。一次调用返回匹配行+行号+上下文，" +
        "通常无需再调 read_file。支持完整正则。优先用本工具，而非 SDK 的 grep。" +
        "用 include/exclude 限定文件类型；用 context 读取匹配处周围代码。默认 content 模式。",
      schema: GrepSearchSchema,
    },
  );
}
