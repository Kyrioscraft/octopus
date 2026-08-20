import type { ReactNode } from "react";
import {
  SquareTerminal,
  Pencil,
  FilePlus,
  FileText,
  Bot,
  Search,
  FolderOpen,
  Globe,
  Wrench,
  CircleHelp,
} from "lucide-react";

/**
 * Tool name → icon mapping. Falls back to <Wrench /> for unknown tools.
 * Adding a new tool only requires one line here.
 */
export const TOOL_ICON_MAP: Record<string, ReactNode> = {
  // Shell
  execute: <SquareTerminal />,
  bash: <SquareTerminal />,
  run_shell_command: <SquareTerminal />,
  cmd: <SquareTerminal />,
  // File edits
  edit_file: <Pencil />,
  replace: <Pencil />,
  write_file: <FilePlus />,
  // File reads
  read_file: <FileText />,
  list_directory: <FolderOpen />,
  ls: <FolderOpen />,
  glob: <Search />,
  grep: <Search />,
  search_file_content: <Search />,
  grep_search: <Search />,
  rg: <Search />,
  find: <Search />,
  // Subagent
  task: <Bot />,
  // Web
  web_search: <Globe />,
  fetch_url: <Globe />,
  // HITL
  ask_user_question: <CircleHelp />,
};

export function getToolIcon(name: string): ReactNode {
  return TOOL_ICON_MAP[name] ?? <Wrench />;
}

/**
 * Human-readable display name for a tool. Falls back to the raw name.
 */
export function getToolDisplayName(name: string): string {
  const map: Record<string, string> = {
    execute: "运行命令",
    bash: "运行命令",
    run_shell_command: "运行命令",
    cmd: "运行命令",
    edit_file: "编辑文件",
    replace: "编辑文件",
    write_file: "写入文件",
    read_file: "读取文件",
    list_directory: "列出目录",
    ls: "列出目录",
    glob: "搜索文件",
    grep: "搜索内容",
    search_file_content: "搜索内容",
    grep_search: "搜索内容",
    rg: "搜索内容",
    find: "查找文件",
    task: "子智能体",
    web_search: "网络搜索",
    fetch_url: "抓取网页",
    ask_user_question: "提问",
  };
  return map[name] ?? name;
}

/**
 * Friendly, localized display name for a subagent, keyed by its `agentNs`.
 *
 * NOTE: the canonical implementation lives in `rows/subagents/display.ts` (it
 * only serves the subagent row rendering). Kept here is only the `task` tool's
 * display-name entry below.
 */

// ---------------------------------------------------------------------------
// Generic helpers (truncate / countLines / basename / inferLanguage) now live
// in widgets/utils.ts. Imported for local use AND re-exported so existing
// consumers importing from "./registry.js" keep working without a sweeping
// import rewrite. New code should import these from "widgets/utils.js" directly.
// ---------------------------------------------------------------------------
import { basename } from "../../../widgets/utils.js";
export { truncate, countLines, basename, inferLanguage } from "../../../widgets/utils.js";

/**
 * 只读探索类工具集合。这类工具(read_file/ls/glob/grep 等)在 agent 一个
 * turn 里经常被批量并行调用,UI 上降级呈现:折叠为一行文件名/搜索词列表,
 * 而非和写操作(edit/write/execute)平起平坐地各占一张卡片。
 *
 * 语义对齐 core 的 READONLY_TOOL_NAMES(built_in_subagents.ts)。
 */
export const READONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "ls",
  "glob",
  "grep",
  "search_file_content",
  "web_search",
  "fetch_url",
]);

/** 判断一个工具调用是否属于只读类(用于 UI 降级呈现)。 */
export function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name);
}

/**
 * 「探索类」工具集合 —— 在 UI 时间线里会被分组合并的工具。
 *
 * 包含 read_file + 列出目录(list_directory/ls) + 搜索(grep/glob/
 * search_file_content/grep_search(内置ripgrep)/rg/find)。
 * 注意:web_search/fetch_url 虽然是只读(见 READONLY_TOOLS),但它们独立成卡显示、
 * 不归入探索组(它们的语义是"联网查资料"而非"探索本地代码库")。
 */
export const EXPLORATION_TOOLS = new Set([
  "read_file",
  "list_directory",
  "ls",
  "glob",
  "grep",
  "search_file_content",
  "grep_search",
  "rg",
  "find",
]);

/** 判断一个工具是否属于探索类(会被分组成「探索组」)。 */
export function isExplorationTool(name: string): boolean {
  return EXPLORATION_TOOLS.has(name);
}

/**
 * 「搜索/查找」类工具 —— 探索组折叠摘要里"搜索了 X 项"的计数来源。
 * 按用户要求把可能出现的搜索/查找命令都覆盖:grep 系(含内置 ripgrep
 * grep_search、裸 rg)、glob/find 文件查找、ls/list_directory 目录列举。
 */
export const SEARCH_TOOLS = new Set([
  "glob",
  "grep",
  "search_file_content",
  "grep_search",
  "rg",
  "find",
  "ls",
  "list_directory",
]);

// ---------------------------------------------------------------------------
// 调用级分类（含 shell 命令嗅探）
//
// agent 常通过 execute/bash 直接跑 ls / grep / rg / find 等命令（而不是调用
// 对应的 SDK 工具）。这些"命令型搜索"同样属于探索类:归入探索组、计入折叠态
// 的"搜索了 X 项"。只嗅探命令的第一个词 —— 若命令含 && / ; / | 等操作符则
// 不归组（无法证明整条命令都是只读探索,保守起见按普通命令工具行显示）。
// ---------------------------------------------------------------------------

/** Shell 类工具名(execute 及别名)。 */
const SHELL_TOOL_NAMES = new Set(["execute", "bash", "run_shell_command", "cmd"]);

/** 只读搜索/查找命令的第一个词(rg/grep/ls/find 家族,把可能出现的都覆盖)。 */
const SEARCH_COMMAND_FIRST =
  /^(rg|grep|egrep|fgrep|ls|dir|find|locate|ag|ack|where|which)\b/i;

/** 提取 shell 调用的命令首词;含 && / ; / | 等操作符时返回 null(不能证明只读)。 */
function shellSearchCommand(entry: { name: string; args: Record<string, unknown> }): string | null {
  if (!SHELL_TOOL_NAMES.has(entry.name)) return null;
  const cmd = String(entry.args.command ?? entry.args.cmd ?? "").trim();
  if (!cmd) return null;
  if (/&&|\|\||[;|>]/.test(cmd)) return null;
  return SEARCH_COMMAND_FIRST.test(cmd) ? cmd : null;
}

/** 调用级探索判断:探索类工具名,或 shell 跑只读搜索/查找命令。 */
export function isExplorationCall(entry: {
  name: string;
  args: Record<string, unknown>;
}): boolean {
  if (EXPLORATION_TOOLS.has(entry.name)) return true;
  return shellSearchCommand(entry) !== null;
}

/** 调用级搜索判断(折叠态"搜索了 X 项"计数)。 */
export function isSearchCall(entry: { name: string; args: Record<string, unknown> }): boolean {
  if (SEARCH_TOOLS.has(entry.name)) return true;
  return shellSearchCommand(entry) !== null;
}

/** 调用级文件读取判断(折叠态"读取了 Y 个文件"计数)。 */
export function isFileReadCall(entry: { name: string; args: Record<string, unknown> }): boolean {
  return entry.name === "read_file";
}

/**
 * 从只读工具的 args 里提取一个"人类可读的目标"(文件名/搜索词),用于折叠态
 * chips 显示。提取不到时返回空串(调用方自行 fallback 到工具显示名)。
 */
export function readonlyToolTarget(name: string, args: Record<string, unknown>): string {
  // read_file / list_directory / ls → file_path / path → 取 basename
  const fp = (args.file_path ?? args.path) as string | undefined;
  if (fp) return basename(fp);
  // glob / grep / search_file_content → pattern / query / search → 截断长模式
  const pat = (args.pattern ?? args.query ?? args.search) as string | undefined;
  if (pat) return pat.length > 24 ? pat.slice(0, 24) + "…" : pat;
  return "";
}
