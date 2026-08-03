import { useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import { Button, Tooltip, Dropdown, Modal, Input, Popconfirm, message as antdMessage } from "antd";
import type { MenuProps } from "antd";
import { useNavigate, useLocation } from "react-router-dom";
import {
  MessageOutlined,
  AppstoreOutlined,
  SettingOutlined,
  MoreOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  BookOutlined,
  ApiOutlined,
  RobotOutlined,
  FolderOpenOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import { OctopusClient, type Thread, type Workspace } from "@octopus/tentacle";
import { useChatStore } from "../../stores/chat.js";
import { DirBrowserModal } from "../workspace/DirBrowserModal.js";
import { formatRelativeTime } from "../../utils/time.js";

const sdk = new OctopusClient();

// Reusable row used by the global search modal results.
function SearchResultRow({
  icon, label, onClick,
}: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "0 10px", height: 36, borderRadius: 8,
        cursor: "pointer", fontSize: 14, color: "var(--gray-700)",
        marginBottom: 2,
        transition: "background-color 0.15s ease, color 0.15s ease",
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
      <span style={{ fontSize: 16, display: "flex", alignItems: "center", color: "var(--gray-500)" }}>
        {icon}
      </span>
      <span style={{
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
      }}>
        {label}
      </span>
    </div>
  );
}

function SearchEmpty() {
  return (
    <div style={{
      textAlign: "center", color: "var(--gray-300)",
      fontSize: 13, padding: "16px 0",
    }}>
      无匹配结果
    </div>
  );
}

const navItems = [
  { key: "search", icon: <SearchOutlined />, label: "搜索" },
  { key: "extensions", icon: <AppstoreOutlined />, label: "扩展管理" },
];

// Static page-feature entries surfaced by the global search modal.
const FEATURES = [
  { label: "新建对话", path: "/agent", icon: <MessageOutlined /> },
  { label: "扩展管理 - 技能", path: "/extensions/skills", icon: <BookOutlined /> },
  { label: "扩展管理 - MCP服务器", path: "/extensions/mcp", icon: <ApiOutlined /> },
  { label: "扩展管理 - 子智能体", path: "/extensions/subagents", icon: <RobotOutlined /> },
  { label: "设置 - 常规", path: "/settings/general", icon: <SettingOutlined /> },
  { label: "设置 - 模型配置", path: "/settings/model", icon: <SettingOutlined /> },
];

export function Sidebar() {
  const {
    threads, setThreads, activeThreadId, setActiveThreadId,
    workspaces, setWorkspaces, activeWorkspaceId, setActiveWorkspaceId,
  } = useChatStore();
  const location = useLocation();
  // Derive the active nav key from the current path so it survives refresh.
  const initialNavKey = location.pathname.startsWith("/extensions")
    ? "extensions"
    : null;
  const [navKey, setNavKey] = useState<string | null>(initialNavKey);
  const navigate = useNavigate();

  // --- Global search modal state ---
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // --- Directory-browser modal (Open Folder) ---
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  // Ctrl/Cmd+K toggles the global search modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((prev) => {
          if (prev) {
            setQuery("");
            return false;
          }
          return true;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try { setWorkspaces(await sdk.listWorkspaces()); } catch { /* */ }
  }, [setWorkspaces]);

  const loadThreads = useCallback(async () => {
    try {
      // Scope the list to the active workspace when one is selected.
      const scope = activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined;
      setThreads(await sdk.listThreads(scope));
    } catch { /* */ }
  }, [setThreads, activeWorkspaceId]);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => { loadThreads(); }, [loadThreads]);

  // Auto-select the most-recently-opened workspace on first load if none chosen.
  useEffect(() => {
    if (!activeWorkspaceId && workspaces.length > 0) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [workspaces, activeWorkspaceId, setActiveWorkspaceId]);

  /** Open Folder — bind a real host directory as the active workspace. */
  const openFolder = useCallback(async (hostPath: string) => {
    try {
      const ws = await sdk.openWorkspace(hostPath);
      await loadWorkspaces();
      setActiveWorkspaceId(ws.id);
      antdMessage.success(`已打开「${ws.name}」`);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "打开目录失败");
    }
  }, [loadWorkspaces, setActiveWorkspaceId]);

  /** Switch workspace → update the store; threads reload reactively (the
   * loadThreads effect depends on activeWorkspaceId) and the active
   * conversation is cleared. No page reload, so the workspace list doesn't
   * re-render/flash — only its selection state changes. */
  const switchWorkspace = (ws: Workspace) => {
    if (ws.id === activeWorkspaceId) return;
    setActiveWorkspaceId(ws.id);
    setActiveThreadId(undefined);
    // Always reset to the fresh-chat view when switching workspace, so the old
    // thread's messages + workspace binding don't linger. We must clear the
    // `?thread=` query (not just navigate), because both `/` and `/agent`
    // render ChatPage — if the query stays, Chat.tsx's URL-driven effect keeps
    // the old thread active and its workspaceId shadows the new selection.
    navigate("/agent");
  };

  // --- Rename / Delete thread state & handlers ---
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);

  const startRename = (t: Thread) => {
    setRenaming(t);
    setRenameValue(t.title);
  };

  const submitRename = async () => {
    if (!renaming) return;
    const title = renameValue.trim();
    if (!title) { antdMessage.warning("标题不能为空"); return; }
    setRenameLoading(true);
    try {
      await sdk.renameThread(renaming.id, title);
      await loadThreads();
      antdMessage.success("已重命名");
      setRenaming(null);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "重命名失败");
    } finally {
      setRenameLoading(false);
    }
  };

  const handleDelete = async (t: Thread) => {
    try {
      await sdk.deleteThread(t.id);
      // If we deleted the active thread, clear it and jump to a fresh chat.
      if (t.id === activeThreadId) {
        setActiveThreadId(undefined);
        navigate("/agent");
      } else {
        await loadThreads();
      }
      antdMessage.success("已删除");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "删除失败");
    }
  };

  const menuFor = (t: Thread): MenuProps["items"] => [
    {
      key: "rename",
      icon: <EditOutlined />,
      label: "重命名",
      onClick: ({ domEvent }) => { domEvent.stopPropagation(); startRename(t); },
    },
    {
      key: "delete",
      icon: <DeleteOutlined />,
      danger: true,
      label: "删除",
      onClick: ({ domEvent }) => { domEvent.stopPropagation(); startDelete(t); },
    },
  ];

  // Popconfirm needs a controlled trigger; we drive it via this pending state.
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const startDelete = (t: Thread) => setPendingDelete(t);

  const handleNewChat = () => {
    setActiveThreadId(undefined);
    navigate("/agent");
  };

  // --- Search results ---
  const q = query.trim().toLowerCase();
  const filteredFeatures = q
    ? FEATURES.filter((f) => f.label.toLowerCase().includes(q))
    : FEATURES;
  const filteredThreads = q
    ? threads.filter((t) => (t.title ?? "").toLowerCase().includes(q))
    : [];

  const jumpToFeature = (path: string) => {
    closeSearch();
    navigate(path);
  };

  const jumpToThread = (t: Thread) => {
    closeSearch();
    setActiveThreadId(t.id);
    navigate(`/?thread=${t.id}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Brand area */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "14px 14px 8px", flexShrink: 0,
      }}>
        <img
          src="/octopus-logo.svg"
          alt="Octopus Logo"
          style={{ width: 28, height: 28 }}
        />
        <span style={{
          fontSize: 15, fontWeight: 650, lineHeight: "20px",
          color: "var(--gray-1000)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          Octopus Agent
        </span>
      </div>

      {/* "创建新对话" — primary action, right under the brand */}
      <div style={{ padding: "0 12px 8px", flexShrink: 0 }}>
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
      <div style={{ padding: "0 8px", flexShrink: 0 }}>
        {navItems.map((item) => (
          <Tooltip key={item.key} title={item.label} placement="right">
            <div
              onClick={() => {
                if (item.key === "search") {
                  openSearch();
                  return;
                }
                setNavKey(item.key);
                if (item.key === "extensions") navigate("/extensions");
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

      {/* Divider — separates action entries from content lists */}
      <div style={{
        margin: "6px 20px", borderTop: "1px solid var(--gray-100)", flexShrink: 0,
      }} />

      {/* Workspace section — list + Open Folder */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        <div style={{
          display: "flex", alignItems: "center",
          padding: "2px 12px 4px",
        }}>
          <span style={{
            fontSize: 12, fontWeight: 600, color: "var(--gray-500)", flex: 1,
          }}>
            工作区
          </span>
          <Tooltip title="打开文件夹">
            <FolderOpenOutlined
              onClick={() => setDirBrowserOpen(true)}
              style={{
                fontSize: 14, color: "var(--gray-500)", cursor: "pointer",
                transition: "color 0.15s ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--main-color)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--gray-500)"; }}
            />
          </Tooltip>
        </div>
        {workspaces.length === 0 ? (
          <div
            onClick={() => setDirBrowserOpen(true)}
            style={{
              margin: "0 4px", padding: "8px 10px", borderRadius: 8,
              cursor: "pointer", fontSize: 12.5, color: "var(--gray-500)",
              border: "1px dashed var(--gray-150)",
            }}
          >
            <FolderOpenOutlined style={{ marginRight: 6 }} />
            打开一个文件夹作为工作区
          </div>
        ) : (
          <div style={{ maxHeight: 160, overflowY: "auto", padding: "0 4px" }}>
            {workspaces.map((ws) => (
              <Tooltip key={ws.id} title={ws.path} placement="right">
                <div
                  onClick={() => switchWorkspace(ws)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "0 10px", height: 32, borderRadius: 8,
                    cursor: "pointer", fontSize: 13,
                    color: ws.id === activeWorkspaceId ? "var(--main-color)" : "var(--gray-700)",
                    background: ws.id === activeWorkspaceId
                      ? "color-mix(in srgb, var(--main-color) 6%, var(--gray-0))"
                      : "transparent",
                    fontWeight: ws.id === activeWorkspaceId ? 600 : 450,
                    marginBottom: 2,
                  }}
                >
                  <DesktopOutlined style={{ fontSize: 15 }} />
                  <span style={{
                    flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {ws.name}
                  </span>
                </div>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      {/* Divider — separates workspace from thread history */}
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
            className="thread-item"
            onClick={() => {
              setActiveThreadId(t.id);
              navigate(`/?thread=${t.id}`);
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
              display: "flex", alignItems: "center", justifyContent: "space-between",
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
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {t.title}
            </span>
            {/* Relative timestamp (always visible, kept as muted secondary text) */}
            <span style={{
              flexShrink: 0, marginLeft: 8,
              fontSize: 11, lineHeight: 1, color: "var(--gray-400)",
              whiteSpace: "nowrap",
            }}>
              {formatRelativeTime(t.createdAt)}
            </span>
            {/* Hover-only more-actions trigger */}
            <Dropdown
              menu={{ items: menuFor(t) }}
              trigger={["click"]}
              placement="bottomRight"
            >
              <span
                className="thread-more"
                onClick={(e) => e.stopPropagation()}
                style={{
                  flexShrink: 0, width: 24, height: 24, borderRadius: 6,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--gray-500)", fontSize: 14,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--gray-100)";
                  e.currentTarget.style.color = "var(--gray-700)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--gray-500)";
                }}
              >
                <MoreOutlined />
              </span>
            </Dropdown>
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

      {/* Footer: User */}
      <div style={{ flexShrink: 0, padding: "4px 8px 10px" }}>
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
              onClick={() => navigate("/settings/general")}
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

      {/* Global search modal */}
      <Modal
        open={searchOpen}
        onCancel={closeSearch}
        footer={null}
        destroyOnHidden
        width={560}
        centered
        styles={{ body: { padding: 0 } }}
        title={null}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPressEnter={() => {
              if (filteredFeatures.length > 0) jumpToFeature(filteredFeatures[0].path);
              else if (filteredThreads.length > 0) jumpToThread(filteredThreads[0]);
            }}
            prefix={<SearchOutlined style={{ color: "var(--gray-400)" }} />}
            placeholder="搜索功能或对话..."
            allowClear
            autoFocus
            size="large"
            style={{ borderRadius: 0, fontSize: 15 }}
            variant="borderless"
          />
          <div style={{
            borderTop: "1px solid var(--gray-100)",
            maxHeight: 360, overflow: "auto", padding: "6px 8px",
          }}>
            {/* Page features group */}
            {(filteredFeatures.length > 0 || q) && (
              <div style={{ padding: "4px 8px 2px" }}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: "var(--gray-500)",
                  padding: "4px 4px 6px",
                }}>
                  页面功能
                </div>
                {filteredFeatures.map((f) => (
                  <SearchResultRow
                    key={f.path}
                    icon={f.icon}
                    label={f.label}
                    onClick={() => jumpToFeature(f.path)}
                  />
                ))}
                {q && filteredFeatures.length === 0 && <SearchEmpty />}
              </div>
            )}

            {/* Conversation history group */}
            {q && (
              <div style={{ padding: "4px 8px 2px" }}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: "var(--gray-500)",
                  padding: "4px 4px 6px",
                }}>
                  对话历史
                </div>
                {filteredThreads.map((t) => (
                  <SearchResultRow
                    key={t.id}
                    icon={<MessageOutlined />}
                    label={t.title}
                    onClick={() => jumpToThread(t)}
                  />
                ))}
                {filteredThreads.length === 0 && <SearchEmpty />}
              </div>
            )}

            {/* Idle hint when no query */}
            {!q && (
              <div style={{
                textAlign: "center", color: "var(--gray-300)",
                fontSize: 13, padding: "24px 0",
              }}>
                输入关键字搜索功能或对话
              </div>
            )}
          </div>
          <div style={{
            borderTop: "1px solid var(--gray-100)", padding: "8px 16px",
            fontSize: 12, color: "var(--gray-400)", textAlign: "right",
          }}>
            Ctrl/⌘ + K 快捷打开
          </div>
        </div>
      </Modal>

      {/* Rename modal */}
      <Modal
        title="重命名对话"
        open={!!renaming}
        onCancel={() => setRenaming(null)}
        onOk={submitRename}
        confirmLoading={renameLoading}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={submitRename}
          placeholder="输入新的对话标题"
          autoFocus
          maxLength={100}
        />
      </Modal>

      {/* Delete confirm — driven by `pendingDelete` via a hidden trigger */}
      <Popconfirm
        title="删除对话"
        description="删除后无法恢复，确定继续吗？"
        open={!!pendingDelete}
        onConfirm={() => {
          const t = pendingDelete;
          setPendingDelete(null);
          if (t) handleDelete(t);
        }}
        onCancel={() => setPendingDelete(null)}
        okText="删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <span style={{ display: "none" }} />
      </Popconfirm>

      {/* Open Folder directory browser */}
      <DirBrowserModal
        open={dirBrowserOpen}
        onClose={() => setDirBrowserOpen(false)}
        onSelect={openFolder}
      />
    </div>
  );
}
