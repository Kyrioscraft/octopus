import { useState, useCallback, useEffect } from "react";
import { Button, Tooltip } from "antd";
import {
  MessageOutlined,
  FolderOpenOutlined,
  AppstoreOutlined,
  GithubOutlined,
  RobotOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { OctopusClient } from "@octopus/tentacle";
import { useChatStore } from "../stores/chat.js";

const sdk = new OctopusClient();

const navItems = [
  { key: "workspace", icon: <FolderOpenOutlined />, label: "工作区" },
  { key: "extensions", icon: <AppstoreOutlined />, label: "扩展管理" },
];

export function Sidebar() {
  const { threads, setThreads, activeThreadId, setActiveThreadId, setConfigOpen } = useChatStore();
  const [navKey, setNavKey] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    try { setThreads(await sdk.listThreads()); } catch { /* */ }
  }, [setThreads]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  const handleNewChat = () => {
    setActiveThreadId(undefined);
    window.location.href = "/agent";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Brand area */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "14px 16px 10px", flexShrink: 0,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: "linear-gradient(135deg, var(--main-500), var(--main-700))",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <RobotOutlined style={{ color: "#fff", fontSize: 16 }} />
        </div>
        <span style={{
          fontSize: 15, fontWeight: 650, lineHeight: "20px",
          color: "var(--gray-1000)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          Octopus Agent
        </span>
      </div>

      {/* "创建新对话" — primary action styling */}
      <div style={{ padding: "0 10px 8px", flexShrink: 0 }}>
        <Button
          block
          onClick={handleNewChat}
          icon={<MessageOutlined />}
          style={{
            borderColor: "var(--gray-150)",
            backgroundColor: "var(--gray-0)",
            color: "var(--main-color)",
            boxShadow: "0 3px 4px rgba(0,10,20,0.02)",
            fontWeight: 500, height: 36, fontSize: 14, borderRadius: 8,
            transition: "box-shadow 0.2s ease, border-color 0.2s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = "0 3px 4px rgba(0,10,20,0.07)";
            e.currentTarget.style.borderColor = "var(--gray-200)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = "0 3px 4px rgba(0,10,20,0.02)";
            e.currentTarget.style.borderColor = "var(--gray-150)";
          }}
        >
          创建新对话
        </Button>
      </div>

      {/* Navigation items */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        {navItems.map((item) => (
          <Tooltip key={item.key} title={item.label} placement="right">
            <div
              onClick={() => {
                setNavKey(item.key);
                if (item.key === "workspace") window.location.href = "/workspace";
                if (item.key === "extensions") window.location.href = "/extensions";
              }}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "0 10px", height: 36, borderRadius: 8,
                cursor: "pointer", fontSize: 14,
                color: navKey === item.key ? "var(--main-color)" : "var(--gray-700)",
                background: navKey === item.key
                  ? "color-mix(in srgb, var(--main-color) 6%, var(--gray-0))"
                  : "transparent",
                fontWeight: navKey === item.key ? 600 : 450,
                marginBottom: 2,
                transition: "background-color 0.2s ease, color 0.2s ease",
              }}
              onMouseEnter={(e) => {
                if (navKey !== item.key) {
                  e.currentTarget.style.backgroundColor = "var(--main-20)";
                  e.currentTarget.style.color = "var(--main-color)";
                }
              }}
              onMouseLeave={(e) => {
                if (navKey !== item.key) {
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
        ))}
      </div>

      {/* Divider */}
      <div style={{
        margin: "6px 20px", borderTop: "1px solid var(--gray-100)", flexShrink: 0,
      }} />

      {/* Thread list */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: "var(--gray-500)",
          padding: "4px 12px 6px",
        }}>
          对话历史
        </div>
        {threads.map((t) => (
          <div
            key={t.id}
            onClick={() => {
              setActiveThreadId(t.id);
              window.location.href = `/?thread=${t.id}`;
            }}
            style={{
              padding: "0 8px", height: 36, borderRadius: 8,
              cursor: "pointer", fontSize: 13, lineHeight: "36px",
              color: t.id === activeThreadId ? "var(--main-color)" : "var(--gray-700)",
              background: t.id === activeThreadId
                ? "color-mix(in srgb, var(--main-color) 6%, var(--gray-0))"
                : "transparent",
              fontWeight: t.id === activeThreadId ? 600 : 400,
              marginBottom: 2, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
              transition: "background-color 0.2s ease, color 0.2s ease",
            }}
            onMouseEnter={(e) => {
              if (t.id !== activeThreadId) {
                e.currentTarget.style.backgroundColor = "var(--main-20)";
                e.currentTarget.style.color = "var(--main-color)";
              }
            }}
            onMouseLeave={(e) => {
              if (t.id !== activeThreadId) {
                e.currentTarget.style.backgroundColor = "transparent";
                e.currentTarget.style.color = "var(--gray-700)";
              }
            }}
          >
            {t.title}
          </div>
        ))}
        {threads.length === 0 && (
          <div style={{
            textAlign: "center", color: "var(--gray-300)",
            fontSize: 13, paddingTop: 20,
          }}>
            暂无对话
          </div>
        )}
      </div>

      {/* Footer: GitHub + User */}
      <div style={{ flexShrink: 0, padding: "4px 8px 10px" }}>
        <a
          href="https://github.com/kyrioscraft/octopus"
          target="_blank" rel="noopener noreferrer"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "0 10px", height: 36, borderRadius: 8,
            color: "var(--gray-700)", fontSize: 14, fontWeight: 450,
            textDecoration: "none",
            transition: "background-color 0.2s ease, color 0.2s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--main-20)";
            e.currentTarget.style.color = "var(--main-color)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--gray-700)";
          }}
        >
          <GithubOutlined style={{ fontSize: 18 }} />
          <span>GitHub</span>
        </a>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "0 10px", height: 36, fontSize: 14,
          color: "var(--gray-700)", fontWeight: 450,
        }}>
          <div style={{
            width: 24, height: 24, borderRadius: "50%",
            background: "var(--main-200)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, color: "var(--main-700)", fontWeight: 600,
          }}>
            O
          </div>
          <span style={{ flex: 1 }}>octopus</span>
          <Tooltip title="设置">
            <SettingOutlined
              onClick={() => setConfigOpen(true)}
              style={{
                fontSize: 16, color: "var(--gray-500)", cursor: "pointer",
                transition: "color 0.15s ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--main-color)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--gray-500)"; }}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
