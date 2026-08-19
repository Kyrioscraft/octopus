/**
 * Built-in slash commands shipped with Octopus.
 *
 * Commands are tagged with a `platform` field so the web and TUI clients can
 * filter to their relevant subset:
 *   - "all"  → shown on both web and TUI
 *   - "web"  → web-only (e.g. page navigation)
 *   - "tui"  → TUI-only (e.g. external editor, quit)
 *
 * User-defined commands (created via extension management) are always
 * `kind: "prompt"` and have no platform restriction.
 */

/** Discriminator: system commands execute app actions; prompt commands insert templates. */
export type SlashCommandKind = "system" | "prompt";

/** Actions for system commands — the web/TUI handler maps these to behavior. */
export type SystemAction =
  | "clear"
  | "theme"
  | "help"
  | "copy-last"
  | "search"
  | "changelog"
  | "version"
  | "feedback"
  | "docs"
  // Navigation (web: React Router, TUI: switch view)
  | { type: "navigate"; path: string }
  // Reserved for future TUI use
  | "model"
  | "agents"
  | "editor"
  | "quit"
  | "notifications"
  | "threads"
  | "update"
  | "install"
  | "auto-update"
  | "tokens"
  | "trace"
  | "offload"
  | "remember"
  | "skill-creator";

export interface BuiltinSlashCommand {
  name: string;
  displayName: string;
  description: string;
  kind: SlashCommandKind;
  systemAction?: SystemAction;
  promptTemplate?: string;
  promptAction?: "insert" | "send";
  platform: "web" | "tui" | "all";
  category?: string | null;
}

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  // =========================================================================
  // 🌐🖥️ 通用命令 (platform: "all")
  // =========================================================================
  {
    name: "clear",
    displayName: "清空对话",
    description: "开始新会话",
    kind: "system",
    systemAction: "clear",
    platform: "all",
    category: "tool",
  },
  {
    name: "theme",
    displayName: "切换主题",
    description: "循环切换 light → dark → system",
    kind: "system",
    systemAction: "theme",
    platform: "all",
    category: "tool",
  },
  {
    name: "help",
    displayName: "帮助",
    description: "显示帮助和快捷键说明",
    kind: "system",
    systemAction: "help",
    platform: "all",
    category: "tool",
  },
  {
    name: "copy",
    displayName: "复制回复",
    description: "复制最后一条助手回复到剪贴板",
    kind: "system",
    systemAction: "copy-last",
    platform: "all",
    category: "tool",
  },
  {
    name: "mcp",
    displayName: "MCP 服务器",
    description: "管理 MCP 服务器配置",
    kind: "system",
    systemAction: { type: "navigate", path: "/extensions/mcp" },
    platform: "all",
    category: "tool",
  },
  {
    name: "changelog",
    displayName: "更新日志",
    description: "查看版本更新日志",
    kind: "system",
    systemAction: "changelog",
    platform: "all",
    category: "info",
  },
  {
    name: "version",
    displayName: "版本信息",
    description: "查看当前版本",
    kind: "system",
    systemAction: "version",
    platform: "all",
    category: "info",
  },
  {
    name: "feedback",
    displayName: "提交反馈",
    description: "提交 Bug 报告或功能建议",
    kind: "system",
    systemAction: "feedback",
    platform: "all",
    category: "info",
  },
  {
    name: "docs",
    displayName: "文档",
    description: "打开使用文档",
    kind: "system",
    systemAction: "docs",
    platform: "all",
    category: "info",
  },

  // =========================================================================
  // 🌐 Web 专用命令
  // =========================================================================
  {
    name: "settings",
    displayName: "设置",
    description: "跳转到设置页面",
    kind: "system",
    systemAction: { type: "navigate", path: "/settings/general" },
    platform: "web",
    category: "tool",
  },
  {
    name: "extensions",
    displayName: "扩展管理",
    description: "管理技能、MCP、子智能体和斜杠命令",
    kind: "system",
    systemAction: { type: "navigate", path: "/extensions/skills" },
    platform: "web",
    category: "tool",
  },
  {
    name: "search",
    displayName: "搜索",
    description: "搜索对话和功能（等同 Ctrl+K）",
    kind: "system",
    systemAction: "search",
    platform: "web",
    category: "tool",
  },

  // =========================================================================
  // 🖥️ TUI 专用命令 (web 端不展示，预留)
  // =========================================================================
  {
    name: "model",
    displayName: "切换模型",
    description: "选择或切换 AI 模型",
    kind: "system",
    systemAction: "model",
    platform: "tui",
    category: "tool",
  },
  {
    name: "agents",
    displayName: "浏览 Agent",
    description: "浏览和切换可用的 Agent",
    kind: "system",
    systemAction: "agents",
    platform: "tui",
    category: "tool",
  },
  {
    name: "editor",
    displayName: "外部编辑器",
    description: "在外部编辑器中编辑提示",
    kind: "system",
    systemAction: "editor",
    platform: "tui",
    category: "tool",
  },
  {
    name: "quit",
    displayName: "退出",
    description: "退出应用",
    kind: "system",
    systemAction: "quit",
    platform: "tui",
    category: "tool",
  },
  {
    name: "notifications",
    displayName: "通知设置",
    description: "配置启动通知偏好",
    kind: "system",
    systemAction: "notifications",
    platform: "tui",
    category: "tool",
  },
  {
    name: "threads",
    displayName: "浏览线程",
    description: "浏览和恢复历史对话",
    kind: "system",
    systemAction: "threads",
    platform: "tui",
    category: "tool",
  },
  {
    name: "update",
    displayName: "检查更新",
    description: "检查并安装更新",
    kind: "system",
    systemAction: "update",
    platform: "tui",
    category: "tool",
  },
  {
    name: "install",
    displayName: "安装扩展",
    description: "安装可选扩展",
    kind: "system",
    systemAction: "install",
    platform: "tui",
    category: "tool",
  },
  {
    name: "auto-update",
    displayName: "自动更新",
    description: "切换自动更新开关",
    kind: "system",
    systemAction: "auto-update",
    platform: "tui",
    category: "tool",
  },
  {
    name: "tokens",
    displayName: "Token 用量",
    description: "查看 Token 使用统计",
    kind: "system",
    systemAction: "tokens",
    platform: "tui",
    category: "info",
  },
  {
    name: "trace",
    displayName: "LangSmith 追踪",
    description: "在 LangSmith 中查看当前线程",
    kind: "system",
    systemAction: "trace",
    platform: "tui",
    category: "info",
  },
  {
    name: "offload",
    displayName: "释放上下文",
    description: "释放上下文窗口空间",
    kind: "system",
    systemAction: "offload",
    platform: "tui",
    category: "tool",
  },
  {
    name: "remember",
    displayName: "更新记忆",
    description: "从对话中更新记忆和技能",
    kind: "system",
    systemAction: "remember",
    platform: "tui",
    category: "tool",
  },
  {
    name: "skill-creator",
    displayName: "技能创建向导",
    description: "引导创建有效的技能",
    kind: "system",
    systemAction: "skill-creator",
    platform: "tui",
    category: "tool",
  },
];
