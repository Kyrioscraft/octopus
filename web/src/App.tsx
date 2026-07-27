import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AppLayout } from "./layouts/AppLayout.js";
import { ChatPage } from "./pages/Chat.js";
import { ExtensionsPage } from "./pages/Extensions.js";
import { SettingsPage } from "./pages/Settings.js";
import { SkillDetailPage } from "./pages/SkillDetail.js";
import { McpDetailPage } from "./pages/McpDetail.js";
import { SubagentDetailPage } from "./pages/SubagentDetail.js";
import { useThemeStore } from "./stores/theme.js";

export function App() {
  // Re-render ConfigProvider whenever the resolved theme flips so antd
  // switches between defaultAlgorithm / darkAlgorithm.
  const resolved = useThemeStore((s) => s.resolved);
  const isDark = resolved === "dark";

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#389e0d",
          borderRadius: 8,
          fontFamily:
            "'HarmonyOS Sans SC', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        components: {
          Select: {
            // Low-saturation neutral-grey selection style — keeps Select
            // dropdowns in step with the grey/minimal input-bar look rather
            // than antd's louder default green (derived from colorPrimary).
            // In dark mode antd's algorithm supplies suitable colors on its
            // own, so only override in light mode.
            ...(isDark
              ? {}
              : {
                  optionSelectedBg: "#eff2f2",      // ≈ var(--gray-100)
                  optionSelectedColor: "#151616",   // ≈ var(--gray-1000)
                  optionSelectedFontWeight: 600,
                  optionActiveBg: "#f2f4f4",         // ≈ var(--gray-50)
                }),
          },
        },
      }}
    >
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<ChatPage />} />
            <Route path="/agent" element={<ChatPage />} />
            {/* Extensions: redirect base to skills, then one route per tab */}
            <Route path="/extensions" element={<Navigate to="/extensions/skills" replace />} />
            <Route path="/extensions/skills" element={<ExtensionsPage tab="skills" />} />
            <Route path="/extensions/mcp" element={<ExtensionsPage tab="mcp" />} />
            <Route path="/extensions/subagents" element={<ExtensionsPage tab="subagents" />} />
            <Route path="/extensions/skill/:name" element={<SkillDetailPage />} />
            <Route path="/extensions/mcp/:name" element={<McpDetailPage />} />
            <Route path="/extensions/subagent/:name" element={<SubagentDetailPage />} />
            {/* Settings: redirect base to general, then one route per tab */}
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/general" element={<SettingsPage tab="general" />} />
            <Route path="/settings/model" element={<SettingsPage tab="model" />} />
          </Route>
          <Route path="*" element={<ChatPage />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}
