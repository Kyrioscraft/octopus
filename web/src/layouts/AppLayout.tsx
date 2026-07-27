import { Outlet, useLocation } from "react-router-dom";
import { Layout } from "antd";
import { Sidebar } from "../components/Sidebar.js";
import { ExtensionsSidebar } from "../components/ExtensionsSidebar.js";
import { SettingsSidebar } from "../components/SettingsSidebar.js";
import { WorkspaceFileTree } from "../components/WorkspaceFileTree.js";
import { useChatStore } from "../stores/chat.js";
import "../styles/theme.css";
import "../styles/markdown.css";

const { Sider, Content } = Layout;

export function AppLayout() {
  const location = useLocation();
  const isSettings = location.pathname.startsWith("/settings");
  const isExtensions = location.pathname.startsWith("/extensions");
  // The file-tree sider is shown only on chat routes (the workspace concept
  // doesn't apply to the settings/extensions pages).
  const isChat = !isSettings && !isExtensions;
  // Collapse state lives in the store so the chat header's workspace button
  // can toggle it.
  const fileTreeCollapsed = useChatStore((s) => s.fileTreeCollapsed);

  const sidebar = isSettings ? (
    <SettingsSidebar />
  ) : isExtensions ? (
    <ExtensionsSidebar />
  ) : (
    <Sidebar />
  );

  return (
    <Layout style={{ height: "100vh" }} hasSider>
      <Sider
        width={252}
        style={{
          background: "var(--main-5)",
          borderRight: "1px solid var(--gray-100)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {sidebar}
      </Sider>
      <Content
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--gray-0)",
        }}
      >
        <Outlet />
      </Content>
      {isChat && !fileTreeCollapsed && (
        <Sider
          width={300}
          style={{
            background: "var(--gray-0)",
            borderLeft: "1px solid var(--gray-100)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <WorkspaceFileTree />
          </div>
        </Sider>
      )}
    </Layout>
  );
}
