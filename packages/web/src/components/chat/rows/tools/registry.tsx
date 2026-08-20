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
 * 包含 read_file + 列出目录(list_directory/ls) + 搜索(grep/glob/search_file_content)。
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
]);

/** 判断一个工具是否属于探索类(会被分组成「探索组」)。 */
export function isExplorationTool(name: string): boolean {
  return EXPLORATION_TOOLS.has(name);
}

/**
 * 探索组里**需要被显示**的工具(用于折叠摘要计数 + 展开 chips)。
 *
 * 排除 list_directory/ls —— 列目录只是辅助手段,既不计入"探索了 N 个文件",
 * 也不在展开的 chips 列表里出现(避免视觉噪音)。read_file 显示为文件名 chip,
 * grep/glob/search_file_content 显示为搜索词 chip。
 */
export const DISPLAYED_EXPLORATION_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "search_file_content",
]);

/** 判断探索组内的某个工具是否应该被显示(排除列出目录)。 */
export function isDisplayedExplorationTool(name: string): boolean {
  return DISPLAYED_EXPLORATION_TOOLS.has(name);
}

/** 判断是否为文件读取工具(用于"探索了 N 个文件"的 N 计数)。 */
export function isFileReadTool(name: string): boolean {
  return name === "read_file";
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
