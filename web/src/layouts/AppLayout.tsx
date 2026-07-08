import { Outlet } from "react-router-dom";
import { Layout } from "antd";
import { Sidebar } from "../components/Sidebar.js";
import "../styles/theme.css";

const { Sider, Content } = Layout;

export function AppLayout() {
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
        <Sidebar />
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
    </Layout>
  );
}
