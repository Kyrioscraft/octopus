import { useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import { Dropdown, Modal, Input, Popconfirm, message as antdMessage } from "antd";
import type { MenuProps } from "antd";
import { useNavigate, useLocation } from "react-router-dom";
import {
  MessageSquare,
  LayoutGrid,
  Settings,
  MoreHorizontal,
  Pencil,
  Trash2,
  Search,
  BookOpen,
  Plug,
  Bot,
  FolderOpen,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  MonitorCog,
  LogOut,
} from "lucide-react";
import { OctopusClient, type Thread, type Workspace } from "@octopus/tentacle";
import { useChatStore } from "../../stores/chat.js";
import { useUiStore } from "../../stores/ui.js";
import { useThemeStore } from "../../stores/theme.js";
import type { ThemeMode } from "../../stores/theme.js";
import { DirBrowserModal } from "../workspace/DirBrowserModal.js";
import { IconButton } from "../widgets/IconButton.js";
import { NavRow, SectionLabel } from "./SidebarNav.js";
import { groupByDay, formatRelativeTime } from "../../utils/time.js";

const sdk = new OctopusClient();

// Reusable row used by the global search palette results.
function SearchResultRow({
  icon, label, onClick,
}: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <div className="ui-row focus-ring" role="button" tabIndex={0} onClick={onClick}>
      <span
        style={{
          fontSize: 15,
          display: "flex",
          alignItems: "center",
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span className="truncate" style={{ flex: 1 }}>
        {label}
      </span>
    </div>
  );
}

function SearchEmpty() {
  return (
    <div
      style={{
        textAlign: "center",
        color: "var(--text-disabled)",
        fontSize: "var(--text-sm)",
        padding: "16px 0",
      }}
    >
      无匹配结果
    </div>
  );
}

// Static page-feature entries surfaced by the command palette.
const FEATURES = [
  { label: "新建任务", path: "/agent", icon: <MessageSquare /> },
  { label: "扩展管理 - 技能", path: "/extensions/skills", icon: <BookOpen /> },
  { label: "扩展管理 - MCP服务器", path: "/extensions/mcp", icon: <Plug /> },
  { label: "扩展管理 - 子智能体", path: "/extensions/subagents", icon: <Bot /> },
  { label: "设置 - 常规", path: "/settings/general", icon: <Settings /> },
  { label: "设置 - 模型配置", path: "/settings/model", icon: <Settings /> },
];

const THEME_OPTIONS: { key: ThemeMode; label: string; icon: ReactNode }[] = [
  { key: "light", label: "浅色", icon: <Sun /> },
  { key: "dark", label: "深色", icon: <Moon /> },
  { key: "system", label: "跟随系统", icon: <MonitorCog /> },
];

/**
 * The chat sidebar: brand + primary actions, workspace list, and the conversation
 * history grouped by day.
 *
 * Collapsed state (`collapsed`) reduces it to a 60px icon rail; the workspace and
 * conversation lists are hidden there because an icon-only entry has no title to
 * identify it — expand to browse history.
 */
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const {
    threads, setThreads, activeThreadId, setActiveThreadId,
    workspaces, setWorkspaces, activeWorkspaceId, setActiveWorkspaceId,
    runningThreads,
  } = useChatStore();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  const location = useLocation();
  // Derive the active nav key from the current path so it survives refresh.
  const initialNavKey = location.pathname.startsWith("/extensions")
    ? "extensions"
    : null;
  const [navKey, setNavKey] = useState<string | null>(initialNavKey);
  const navigate = useNavigate();

  // --- Global search palette state ---
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // --- Directory-browser modal (Open Folder) ---
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);

  const openSearch = useCallback(() => setSearchOpen(true), []);

  // Listen for slash-command /search event.
  useEffect(() => {
    const handler = () => setSearchOpen(true);
    window.addEventListener("octopus:open-search", handler);
    return () => window.removeEventListener("octopus:open-search", handler);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  // Ctrl/Cmd+K toggles the search palette.
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

  // While any thread has a run executing server-side, poll the thread list so
  // running indicators (and titles) stay fresh even when the run's events are
  // being consumed by a detached/reattached stream elsewhere.
  const anyRunning = Object.keys(runningThreads).length > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => { loadThreads(); }, 5000);
    return () => clearInterval(t);
  }, [anyRunning, loadThreads]);

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
      icon: <Pencil />,
      label: "重命名",
      onClick: ({ domEvent }) => { domEvent.stopPropagation(); startRename(t); },
    },
    {
      key: "delete",
      icon: <Trash2 />,
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

  const openThread = (t: Thread) => {
    setActiveThreadId(t.id);
    navigate(`/?thread=${t.id}`);
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
    openThread(t);
  };

  const threadGroups = groupByDay(threads, (t) => t.createdAt);

  /* Collapsed rail: the brand, the primary actions and the footer. Lists are
     hidden — an icon-only conversation entry carries no identifying title. */
  if (collapsed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center" }}>
        <div style={{ padding: "14px 0 6px", flexShrink: 0 }}>
          <img src="/octopus-logo.svg" alt="Octopus" style={{ width: 28, height: 28 }} />
        </div>
        <div style={{ padding: "0 0 6px", flexShrink: 0 }}>
          <IconButton icon={<PanelLeftOpen />} title="展开侧栏" onClick={toggleSidebar} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0", width: "100%", alignItems: "center", flexShrink: 0 }}>
          <div style={{ width: 36 }}>
            <NavRow icon={<MessageSquare />} label="新建任务" collapsed onClick={handleNewChat} />
          </div>
          <div style={{ width: 36 }}>
            <NavRow icon={<Search />} label="搜索" collapsed onClick={openSearch} />
          </div>
          <div style={{ width: 36 }}>
            <NavRow
              icon={<LayoutGrid />}
              label="扩展管理"
              collapsed
              active={navKey === "extensions"}
              onClick={() => { setNavKey("extensions"); navigate("/extensions"); }}
            />
          </div>
          <div style={{ width: 36 }}>
            <NavRow
              icon={<FolderOpen />}
              label="打开文件夹"
              collapsed
              onClick={() => setDirBrowserOpen(true)}
            />
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 0 12px", alignItems: "center", flexShrink: 0 }}>
          <IconButton
            icon={themeMode === "dark" ? <Sun /> : <Moon />}
            title="切换主题"
            onClick={() => setThemeMode(themeMode === "dark" ? "light" : "dark")}
          />
          <IconButton icon={<Settings />} title="设置" onClick={() => navigate("/settings/general")} />
        </div>

        {/* Modals stay mounted so Ctrl+K still works from the rail. */}
        {searchModal()}
        {renameModal()}
        {deleteConfirm()}
        <DirBrowserModal
          open={dirBrowserOpen}
          onClose={() => setDirBrowserOpen(false)}
          onSelect={openFolder}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Brand + collapse */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "12px 8px 10px 14px", flexShrink: 0,
      }}>
        <img
          src="/octopus-logo.svg"
          alt="Octopus Logo"
          style={{ width: 26, height: 26 }}
        />
        <span style={{
          fontSize: "var(--text-base)", fontWeight: 600, letterSpacing: "-0.01em",
          color: "var(--gray-1000)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
        }}>
          Octopus Agent
        </span>
        <IconButton icon={<PanelLeftClose />} title="收起侧栏" size={28} iconSize={15} onClick={toggleSidebar} />
      </div>

      {/* Navigation items — "新建任务" is an action row like any other, so the
          sidebar is one flat list of entries rather than a CTA plus a list. The
          solid accent stays reserved for the composer's send button. */}
      <div style={{ padding: "0 8px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <NavRow
          icon={<MessageSquare />}
          label="新建任务"
          onClick={handleNewChat}
        />
        <NavRow
          icon={<Search />}
          label="搜索"
          onClick={openSearch}
          trail={<span className="kbd">⌘K</span>}
        />
        <NavRow
          icon={<LayoutGrid />}
          label="扩展管理"
          active={navKey === "extensions"}
          onClick={() => { setNavKey("extensions"); navigate("/extensions"); }}
        />
      </div>

      {/* Workspace section — list + Open Folder */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", paddingRight: 4 }}>
          <span style={{ flex: 1 }}>
            <SectionLabel>工作区</SectionLabel>
          </span>
          <IconButton
            icon={<FolderOpen />}
            title="打开文件夹"
            size={24}
            iconSize={14}
            onClick={() => setDirBrowserOpen(true)}
          />
        </div>
        {workspaces.length === 0 ? (
          <div
            className="focus-ring"
            role="button"
            tabIndex={0}
            onClick={() => setDirBrowserOpen(true)}
            style={{
              margin: "0 4px", padding: "8px 10px",
              borderRadius: "var(--radius-sm)", cursor: "pointer",
              fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
              border: "1px dashed var(--border-default)",
            }}
          >
            <FolderOpen style={{ marginRight: 6 }} />
            打开一个文件夹作为工作区
          </div>
        ) : (
          <div style={{ maxHeight: 168, overflowY: "auto" }}>
            {workspaces.map((ws) => (
              <div key={ws.id} style={{ marginBottom: 2 }}>
                <NavRow
                  icon={<Monitor />}
                  label={ws.name}
                  active={ws.id === activeWorkspaceId}
                  onClick={() => switchWorkspace(ws)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Divider — separates workspace from thread history */}
      <div style={{ margin: "4px 16px", borderTop: "1px solid var(--border-subtle)", flexShrink: 0 }} />

      {/* Thread history — the section header stays pinned while only the list
          scrolls. The scroll container sits inside the same 8px inset as the
          workspace list above, so both panels' scrollbars align vertically. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "0 8px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", paddingRight: 4, flexShrink: 0 }}>
          <span style={{ flex: 1 }}>
            <SectionLabel>任务</SectionLabel>
          </span>
          <IconButton
            icon={<MessageSquare />}
            title="新建任务"
            size={24}
            iconSize={14}
            onClick={handleNewChat}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {threads.length === 0 && (
          <div style={{
            textAlign: "center", color: "var(--text-disabled)",
            fontSize: "var(--text-sm)", paddingTop: 16,
          }}>
            暂无对话
          </div>
        )}

        {threadGroups.map(({ group, items }) => (
          <div key={group}>
            <div style={{
              padding: "10px 8px 4px",
              fontSize: "var(--text-2xs)", fontWeight: 600,
              color: "var(--text-tertiary)", letterSpacing: "0.04em",
            }}>
              {group}
            </div>
            {items.map((t) => {
              const active = t.id === activeThreadId;
              return (
                <div
                  key={t.id}
                  className={`ui-row thread-item focus-ring${active ? " is-active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={active ? "page" : undefined}
                  onClick={() => openThread(t)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openThread(t);
                    }
                  }}
                  style={{ marginBottom: 2 }}
                >
                  {/* Running indicator — the thread's agent run is still executing
                      server-side in the background. */}
                  {runningThreads[t.id] && (
                    <span
                      title="正在运行"
                      style={{
                        flexShrink: 0, width: 6, height: 6, borderRadius: "50%",
                        background: "var(--accent-solid)",
                        animation: "dotPulse 1.4s var(--ease) infinite",
                      }}
                    />
                  )}
                  <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                    {t.title}
                  </span>
                  {/* One slot holds both the timestamp and the actions trigger. */}
                  <span className="thread-slot">
                    <span className="thread-time">{formatRelativeTime(t.createdAt)}</span>
                    <Dropdown
                      menu={{ items: menuFor(t) }}
                      trigger={["click"]}
                      placement="bottomRight"
                    >
                      <span
                        className="thread-more"
                        role="button"
                        aria-label="更多操作"
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer", color: "var(--text-tertiary)", fontSize: 15 }}
                      >
                        <MoreHorizontal />
                      </span>
                    </Dropdown>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        </div>
      </div>

      {/* Footer: user + preferences */}
      <div style={{ flexShrink: 0, padding: "6px 8px 10px", borderTop: "1px solid var(--border-subtle)" }}>
        <Dropdown
          trigger={["click"]}
          placement="topLeft"
          menu={{
            items: [
              { key: "settings", icon: <Settings />, label: "设置", onClick: () => navigate("/settings/general") },
              { type: "divider" },
              {
                key: "theme",
                icon: <Sun />,
                label: "外观",
                children: THEME_OPTIONS.map((o) => ({
                  key: `theme-${o.key}`,
                  icon: o.icon,
                  label: o.label,
                  onClick: () => setThemeMode(o.key),
                })),
              },
              { type: "divider" },
              {
                key: "logout",
                icon: <LogOut />,
                danger: true,
                label: "退出登录",
                onClick: () => { sdk.setToken(""); window.location.href = "/"; },
              },
            ],
          }}
        >
          <div
            className="ui-row focus-ring"
            role="button"
            tabIndex={0}
            style={{ height: 36 }}
          >
            <span
              style={{
                width: 26, height: 26, borderRadius: "var(--radius-full)",
                background: "var(--bg-muted)", border: "1px solid var(--border-default)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "var(--text-xs)", color: "var(--text-secondary)", fontWeight: 600,
                flexShrink: 0,
              }}
            >
              O
            </span>
            <span className="truncate" style={{ flex: 1, color: "var(--text-primary)" }}>
              octopus
            </span>
            <span style={{ display: "flex", fontSize: 14, color: "var(--text-disabled)" }}>
              <MoreHorizontal />
            </span>
          </div>
        </Dropdown>
      </div>

      {searchModal()}
      {renameModal()}
      {deleteConfirm()}

      {/* Open Folder directory browser */}
      <DirBrowserModal
        open={dirBrowserOpen}
        onClose={() => setDirBrowserOpen(false)}
        onSelect={openFolder}
      />
    </div>
  );

  // --- Modal renderers -----------------------------------------------------
  // Kept as closures so the collapsed rail and the full sidebar share one
  // implementation instead of duplicating markup.

  function searchModal() {
    return (
      <Modal
        open={searchOpen}
        onCancel={closeSearch}
        footer={null}
        destroyOnHidden
        width={560}
        centered
        styles={{ body: { padding: 0 }, content: { padding: 0, overflow: "hidden" } }}
        title={null}
        closable={false}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 14px 4px 16px" }}>
            <Search style={{ color: "var(--text-tertiary)", fontSize: 16, flexShrink: 0 }} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onPressEnter={() => {
                if (filteredThreads.length > 0) jumpToThread(filteredThreads[0]);
                else if (filteredFeatures.length > 0) jumpToFeature(filteredFeatures[0].path);
              }}
              placeholder="搜索功能或对话..."
              allowClear
              autoFocus
              style={{ fontSize: "var(--text-md)", padding: "10px 0" }}
              variant="borderless"
            />
          </div>
          <div style={{
            borderTop: "1px solid var(--border-subtle)",
            maxHeight: 380, overflow: "auto", padding: "6px 8px 8px",
          }}>
            {/* Conversation history group */}
            {q && (
              <div>
                <div style={{ padding: "8px 8px 4px" }}>
                  <span className="section-label">任务</span>
                </div>
                {filteredThreads.map((t) => (
                  <SearchResultRow
                    key={t.id}
                    icon={<MessageSquare />}
                    label={t.title}
                    onClick={() => jumpToThread(t)}
                  />
                ))}
                {filteredThreads.length === 0 && <SearchEmpty />}
              </div>
            )}

            {/* Page features group */}
            {(filteredFeatures.length > 0 || q) && (
              <div>
                <div style={{ padding: "8px 8px 4px" }}>
                  <span className="section-label">页面功能</span>
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

            {/* Idle hint when no query */}
            {!q && (
              <div style={{
                textAlign: "center", color: "var(--text-disabled)",
                fontSize: "var(--text-sm)", padding: "24px 0",
              }}>
                输入关键字搜索功能或对话
              </div>
            )}
          </div>
          <div style={{
            borderTop: "1px solid var(--border-subtle)", padding: "8px 14px",
            fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span className="kbd">Esc</span>
            <span>关闭</span>
            <span style={{ flex: 1 }} />
            <span className="kbd">Ctrl</span>
            <span className="kbd">K</span>
          </div>
        </div>
      </Modal>
    );
  }

  function renameModal() {
    return (
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
    );
  }

  function deleteConfirm() {
    return (
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
    );
  }
}