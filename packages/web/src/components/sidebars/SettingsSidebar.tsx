import { useLocation } from "react-router-dom";
import { Settings, FlaskConical } from "lucide-react";
import { SectionSidebar } from "./SidebarNav.js";

type Tab = "general" | "model";

const MENU_ITEMS: { key: Tab; path: string; icon: React.ReactNode; label: string }[] = [
  { key: "general", path: "/settings/general", icon: <Settings />, label: "常规" },
  { key: "model", path: "/settings/model", icon: <FlaskConical />, label: "模型配置" },
];

/**
 * Settings sidebar — replaces the chat sidebar when the route is under
 * /settings/*. Shares its row styling with the other sidebars via SectionSidebar.
 */
export function SettingsSidebar({ collapsed }: { collapsed?: boolean }) {
  const path = useLocation().pathname;
  const activeKey: Tab = path.startsWith("/settings/model") ? "model" : "general";

  return (
    <SectionSidebar
      label="设置"
      items={MENU_ITEMS}
      activeKey={activeKey}
      collapsed={collapsed}
    />
  );
}