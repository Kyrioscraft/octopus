import { Outlet, useLocation } from "react-router-dom";
import { Layout } from "antd";
import { Sidebar } from "../components/sidebars/Sidebar.js";
import { ExtensionsSidebar } from "../components/sidebars/ExtensionsSidebar.js";
import { SettingsSidebar } from "../components/sidebars/SettingsSidebar.js";
import "../styles/theme.css";
import "../styles/markdown.css";

const { Sider, Content } = Layout;

export function AppLayout() {
  const location = useLocation();
  const isSettings = location.pathname.startsWith("/settings");
  const isExtensions = location.pathname.startsWith("/extensions");

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
      {/*
        The right-side secondary surface (workspace files / subagents / todos)
        is now the generic Companion panel (components/chat/companion), rendered inside ChatPage (it needs
        message-derived data). It overlays the content rather than pushing it.
      */}
    </Layout>
  );
}
