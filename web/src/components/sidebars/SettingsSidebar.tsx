import { useNavigate, useLocation } from "react-router-dom";
import { Button, Tooltip } from "antd";
import { ArrowLeftOutlined, SettingOutlined, ExperimentOutlined } from "@ant-design/icons";

type Tab = "general" | "model";

const MENU_ITEMS: { key: Tab; path: string; icon: React.ReactNode; label: string }[] = [
  { key: "general", path: "/settings/general", icon: <SettingOutlined />, label: "常规" },
  { key: "model", path: "/settings/model", icon: <ExperimentOutlined />, label: "模型配置" },
];

/**
 * Settings sidebar — replaces the chat sidebar when the route is under
 * /settings/*. Provides a back-to-chat button and two menu entries
 * (常规 / 模型配置). Visual style mirrors the main Sidebar + ExtensionsSidebar.
 */
export function SettingsSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const path = location.pathname;
  const activeKey: Tab = path.startsWith("/settings/model") ? "model" : "general";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Back to chat */}
      <div style={{ padding: "12px 8px 4px", flexShrink: 0 }}>
        <Tooltip title="返回对话" placement="right">
          <Button
            block
            onClick={() => navigate("/")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "flex-start",
              gap: 8, height: 36, padding: "0 10px", borderRadius: 8,
              fontSize: 14, fontWeight: 450, color: "var(--gray-700)",
              border: "1px solid var(--gray-150)", background: "var(--gray-0)",
            }}
            icon={<ArrowLeftOutlined style={{ fontSize: 16 }} />}
          >
            返回对话
          </Button>
        </Tooltip>
      </div>

      {/* Section label */}
      <div style={{ padding: "12px 18px 4px", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--gray-400)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
          设置
        </span>
      </div>

      {/* Menu items */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        {MENU_ITEMS.map((item) => {
          const active = activeKey === item.key;
          return (
            <Tooltip key={item.key} title={item.label} placement="right">
              <div
                onClick={() => navigate(item.path)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "0 10px", height: 36, borderRadius: 8,
                  cursor: "pointer", fontSize: 14,
                  color: active ? "var(--main-color)" : "var(--gray-700)",
                  background: active
                    ? "color-mix(in srgb, var(--main-color) 6%, var(--gray-0))"
                    : "transparent",
                  fontWeight: active ? 600 : 450,
                  marginBottom: 2,
                  transition: "background-color 0.2s ease, color 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.backgroundColor = "var(--main-20)";
                    e.currentTarget.style.color = "var(--main-color)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.backgroundColor = "transparent";
                    e.currentTarget.style.color = "var(--gray-700)";
                  }
                }}
              >
                <span style={{ fontSize: 18, display: "flex", alignItems: "center" }}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
