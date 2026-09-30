import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { buildAntdTheme } from "./styles/antdTheme.js";
import { AppLayout } from "./layouts/AppLayout.js";
import { ChatPage } from "./pages/Chat.js";
import { ExtensionsPage } from "./pages/Extensions.js";
import { SettingsPage } from "./pages/Settings.js";
import { SkillDetailPage } from "./pages/SkillDetail.js";
import { McpDetailPage } from "./pages/McpDetail.js";
import { SubagentDetailPage } from "./pages/SubagentDetail.js";
import {
  McpFormPage,
  SkillFormPage,
  SubagentFormPage,
  SlashCommandFormPage,
} from "./pages/ExtensionForms.js";
import { useThemeStore } from "./stores/theme.js";

export function App() {
  // Re-render ConfigProvider whenever the resolved theme flips so antd
  // switches between defaultAlgorithm / darkAlgorithm.
  const resolved = useThemeStore((s) => s.resolved);
  const isDark = resolved === "dark";

  return (
    <ConfigProvider locale={zhCN} theme={buildAntdTheme(isDark)}>
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
            <Route path="/extensions/commands" element={<ExtensionsPage tab="commands" />} />
            {/* Extension create/edit forms (settings-style pages). "new" must
                come before the ":name" detail routes to avoid the literal
                "new" being captured as a name. */}
            <Route path="/extensions/skill/new" element={<SkillFormPage />} />
            <Route path="/extensions/skill/:name/edit" element={<SkillFormPage />} />
            <Route path="/extensions/mcp/new" element={<McpFormPage />} />
            <Route path="/extensions/mcp/:name/edit" element={<McpFormPage />} />
            <Route path="/extensions/subagent/new" element={<SubagentFormPage />} />
            <Route path="/extensions/subagent/:name/edit" element={<SubagentFormPage />} />
            <Route path="/extensions/command/new" element={<SlashCommandFormPage />} />
            <Route path="/extensions/command/:id/edit" element={<SlashCommandFormPage />} />
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
