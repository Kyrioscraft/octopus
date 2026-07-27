import type { ReactNode } from "react";
import {
  CodeOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  RobotOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  ToolOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";

/**
 * Tool name → icon mapping. Falls back to <ToolOutlined /> for unknown tools.
 * Adding a new tool only requires one line here.
 */
export const TOOL_ICON_MAP: Record<string, ReactNode> = {
  // Shell
  execute: <CodeOutlined />,
  bash: <CodeOutlined />,
  run_shell_command: <CodeOutlined />,
  cmd: <CodeOutlined />,
  // File edits
  edit_file: <EditOutlined />,
  replace: <EditOutlined />,
  write_file: <FileAddOutlined />,
  // File reads
  read_file: <FileTextOutlined />,
  list_directory: <FolderOpenOutlined />,
  ls: <FolderOpenOutlined />,
  glob: <SearchOutlined />,
  grep: <SearchOutlined />,
  search_file_content: <SearchOutlined />,
  // Subagent
  task: <RobotOutlined />,
  // Web
  web_search: <GlobalOutlined />,
  fetch_url: <GlobalOutlined />,
  // HITL
  ask_user_question: <QuestionCircleOutlined />,
};

export function getToolIcon(name: string): ReactNode {
  return TOOL_ICON_MAP[name] ?? <ToolOutlined />;
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
 * Count the number of lines in a (possibly undefined/empty) string. Used for
 * the +N/-M tags on file-edit cards (industry-standard summary, à la Cline).
 */
export function countLines(s: string | undefined | null): number {
  if (!s) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed === "") return 0;
  return trimmed.split("\n").length;
}

/**
 * Extract the basename from a path. Works with both / and \ separators.
 */
export function basename(p: string | undefined | null): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Infer a refractor/prism language name from a file path's extension. Used to
 * drive syntax highlighting in the diff viewer and code blocks.
 */
export function inferLanguage(filePath: string | undefined | null): string {
  if (!filePath) return "text";
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", html: "html", htm: "html", xml: "xml", css: "css", scss: "scss",
    json: "json", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
    md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", vue: "vue", svelte: "svelte", dockerfile: "docker",
  };
  return map[ext] ?? "text";
}

/**
 * Truncate a string to maxLen characters, appending "…" if shortened.
 */
export function truncate(s: string | undefined | null, maxLen: number): string {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}
