import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AppLayout } from "./layouts/AppLayout.js";
import { ChatPage } from "./pages/Chat.js";

export function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#198cb2",
          borderRadius: 8,
          fontFamily:
            "'HarmonyOS Sans SC', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        algorithm: antdTheme.defaultAlgorithm,
      }}
    >
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<ChatPage />} />
            <Route path="/agent" element={<ChatPage />} />
          </Route>
          <Route path="*" element={<ChatPage />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}
