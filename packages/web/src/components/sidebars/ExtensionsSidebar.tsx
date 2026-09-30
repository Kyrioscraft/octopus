import { useLocation } from "react-router-dom";
import { BookOpen, Plug, Bot, Terminal } from "lucide-react";
import { SectionSidebar } from "./SidebarNav.js";

type Tab = "skills" | "mcp" | "subagents" | "commands";

const MENU_ITEMS: { key: Tab; path: string; icon: React.ReactNode; label: string }[] = [
  { key: "skills", path: "/extensions/skills", icon: <BookOpen />, label: "技能" },
  { key: "mcp", path: "/extensions/mcp", icon: <Plug />, label: "MCP服务器" },
  { key: "subagents", path: "/extensions/subagents", icon: <Bot />, label: "子智能体" },
  { key: "commands", path: "/extensions/commands", icon: <Terminal />, label: "斜杠命令" },
];

/**
 * Extensions management sidebar — replaces the chat sidebar when the route is
 * under /extensions/*. Detail routes (/extensions/skill/:name etc.) highlight
 * their parent section.
 */
export function ExtensionsSidebar({ collapsed }: { collapsed?: boolean }) {
  const path = useLocation().pathname;
  // Detail routes (/extensions/skill/:name etc.) also highlight their parent section.
  const activeKey: Tab = path.startsWith("/extensions/mcp")
    ? "mcp"
    : path.startsWith("/extensions/subagent")
      ? "subagents"
      : path.startsWith("/extensions/command")
        ? "commands"
        : "skills";

  return (
    <SectionSidebar
      label="扩展管理"
      items={MENU_ITEMS}
      activeKey={activeKey}
      collapsed={collapsed}
    />
  );
}