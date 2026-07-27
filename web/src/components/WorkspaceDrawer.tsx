import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer, Tree, Button, Tooltip, Breadcrumb, Spin, message as antdMessage, Empty, Dropdown, Modal, Input, Upload } from "antd";
import type { MenuProps, TreeDataNode, UploadProps } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  DownloadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  DesktopOutlined,
  CloudServerOutlined,
  MoreOutlined,
  UploadOutlined,
  FolderAddOutlined,
  HomeOutlined,
} from "@ant-design/icons";
import { OctopusClient, type Workspace, type WorkspaceEntry, type WorkspaceFileContent } from "@octopus/tentacle";
import { FilePreview } from "./FilePreview.js";

// =============================================================================
// WorkspaceDrawer — in-conversation file viewer (right-side slide-out).
//
// Mirrors yuxi's AgentPanel.vue. Lists files under the conversation's
// workspace, with a tab to scope to the conversation's outputs/ subdir vs.
// the full workspace root. Clicking a file loads its content + preview type;
// binary previews (image/pdf) are fetched as a blob.
// =============================================================================

const sdk = new OctopusClient();

export interface WorkspaceDrawerProps {
  open: boolean;
  workspaceId?: string | null;
  threadId?: string | null;
  onClose: () => void;
}

type Scope = "outputs" | "root";

export function WorkspaceDrawer({ open, workspaceId, threadId, onClose }: WorkspaceDrawerProps) {
  const [scope, setScope] = useState<Scope>("outputs");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [cwd, setCwd] = useState<string>(""); // current subdirectory (relative path)
  const [loadingTree, setLoadingTree] = useState(false);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");

  const isSandbox = workspace?.environment === "sandbox";

  // Fetch the workspace row so we know its environment (sandbox has no files).
  useEffect(() => {
    if (open && workspaceId) {
      setWorkspace(null);
      sdk.getWorkspace(workspaceId).then(setWorkspace).catch(() => setWorkspace(null));
    }
  }, [open, workspaceId]);

  const basePath = useMemo(() => {
    if (scope === "outputs" && threadId) return `outputs/${threadId}`;
    return "";
  }, [scope, threadId]);

  const listPath = useMemo(() => {
    if (!basePath) return cwd || undefined;
    return cwd ? `${basePath}/${cwd}` : basePath;
  }, [basePath, cwd]);

  const loadTree = useCallback(async () => {
    if (!workspaceId) return;
    // Sandbox has no real filesystem backend — skip the tree request entirely.
    if (isSandbox) { setEntries([]); return; }
    setLoadingTree(true);
    try {
      const items = await sdk.getWorkspaceTree(workspaceId, listPath);
      setEntries(items);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "加载文件列表失败");
      setEntries([]);
    } finally {
      setLoadingTree(false);
    }
  }, [workspaceId, listPath, isSandbox]);

  useEffect(() => {
    if (open && workspaceId) {
      setCwd("");
      setSelected(null);
      setFile(null);
      loadTree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, scope, threadId]);

  // Refresh whenever cwd changes.
  useEffect(() => {
    if (open && workspaceId) loadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPath]);

  // Revoke object URLs to avoid leaks.
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const loadFile = useCallback(
    async (entry: WorkspaceEntry) => {
      if (!workspaceId || entry.isDir) return;
      const fullPath = listPath ? `${listPath}/${entry.name}` : entry.name;
      setSelected(entry);
      setLoadingFile(true);
      setFile(null);
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        setBlobUrl(null);
      }
      try {
        const content = await sdk.getWorkspaceFile(workspaceId, fullPath);
        setFile(content);
        // Binary types need a blob URL.
        if (content.previewType === "image" || content.previewType === "pdf") {
          const blob = await sdk.downloadWorkspaceFile(workspaceId, fullPath);
          setBlobUrl(URL.createObjectURL(blob));
        }
      } catch (err: any) {
        antdMessage.error(err?.message ?? "加载文件失败");
      } finally {
        setLoadingFile(false);
      }
    },
    [workspaceId, listPath, blobUrl],
  );

  const handleDownload = useCallback(async () => {
    if (!workspaceId || !selected) return;
    const fullPath = listPath ? `${listPath}/${selected.name}` : selected.name;
    try {
      const blob = await sdk.downloadWorkspaceFile(workspaceId, fullPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = selected.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "下载失败");
    }
  }, [workspaceId, selected, listPath]);

  // Breadcrumb segments over cwd.
  const crumbs = useMemo(() => {
    const segs = cwd ? cwd.split("/") : [];
    return segs.map((s, i) => ({ name: s, path: segs.slice(0, i + 1).join("/") }));
  }, [cwd]);

  /** Download a specific entry (used from the per-file action menu). */
  const downloadEntry = useCallback(
    async (entry: WorkspaceEntry) => {
      if (!workspaceId || entry.isDir) return;
      const fullPath = listPath ? `${listPath}/${entry.name}` : entry.name;
      try {
        const blob = await sdk.downloadWorkspaceFile(workspaceId, fullPath);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err: any) {
        antdMessage.error(err?.message ?? "下载失败");
      }
    },
    [workspaceId, listPath],
  );

  /** Delete a specific entry (used from the per-file action menu). */
  const deleteEntry = useCallback(
    async (entry: WorkspaceEntry) => {
      if (!workspaceId) return;
      try {
        await sdk.deleteWorkspacePath(workspaceId, entry.path);
        antdMessage.success("已删除");
        if (selected?.path === entry.path) { setSelected(null); setFile(null); }
        loadTree();
      } catch (err: any) {
        antdMessage.error(err?.message ?? "删除失败");
      }
    },
    [workspaceId, selected, loadTree],
  );

  const entryMenu = useCallback(
    (e: WorkspaceEntry): MenuProps["items"] => [
      {
        key: "download", icon: <DownloadOutlined />, label: "下载",
        disabled: e.isDir,
        onClick: ({ domEvent }) => { domEvent.stopPropagation(); downloadEntry(e); },
      },
      {
        key: "delete", icon: <DeleteOutlined />, danger: true, label: "删除",
        onClick: ({ domEvent }) => { domEvent.stopPropagation(); deleteEntry(e); },
      },
    ],
    [downloadEntry, deleteEntry],
  );

  const treeData: TreeDataNode[] = useMemo(
    () =>
      entries.map((e) => ({
        key: e.path,
        title: (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%" }}
            onClick={(ev) => {
              if (e.isDir) {
                ev.stopPropagation();
                onEnterDir(e.path);
              }
            }}
          >
            {e.isDir ? <FolderOutlined style={{ color: "var(--main-color)" }} /> : <FileOutlined />}
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.name}
            </span>
            {e.isDir && <span style={{ color: "var(--gray-400)", fontSize: 11 }}>›</span>}
            <Dropdown menu={{ items: entryMenu(e) }} trigger={["click"]}>
              <MoreOutlined
                onClick={(ev) => ev.stopPropagation()}
                style={{ color: "var(--gray-400)", fontSize: 14, padding: "0 2px" }}
              />
            </Dropdown>
          </span>
        ),
        isLeaf: !e.isDir,
      })),
    [entries, entryMenu],
  );

  const onEnterDir = (path: string) => {
    setCwd(path);
    setSelected(null);
    setFile(null);
  };

  const onTreeSelect = (keys: React.Key[]) => {
    const key = keys[0] as string | undefined;
    if (!key) return;
    const entry = entries.find((e) => e.path === key);
    if (entry && !entry.isDir) loadFile(entry);
  };

  const handleSave = useCallback(
    async (content: string) => {
      if (!workspaceId || !selected) return;
      const fullPath = listPath ? `${listPath}/${selected.name}` : selected.name;
      await sdk.saveWorkspaceFile(workspaceId, fullPath, content);
      setFile((f) => (f ? { ...f, content } : f));
    },
    [workspaceId, selected, listPath],
  );

  const createFolder = useCallback(async () => {
    const name = folderName.trim();
    if (!workspaceId || !name) return;
    try {
      await sdk.createWorkspaceDirectory(workspaceId, name, listPath || undefined);
      setNewFolderOpen(false); setFolderName("");
      loadTree();
      antdMessage.success("已创建文件夹");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "创建失败");
    }
  }, [workspaceId, folderName, listPath, loadTree]);

  const uploadProps: UploadProps = {
    multiple: false,
    showUploadList: false,
    customRequest: async (opts) => {
      if (!workspaceId) return;
      const f = opts.file as File;
      try {
        await sdk.uploadWorkspaceFile(workspaceId, f, listPath || undefined);
        antdMessage.success(`已上传 ${f.name}`);
        loadTree();
      } catch (err: any) {
        antdMessage.error(err?.message ?? "上传失败");
      }
    },
  };

  return (
    <Drawer
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {isSandbox
            ? <CloudServerOutlined style={{ color: "var(--gray-400)" }} />
            : <DesktopOutlined style={{ color: "var(--main-color)" }} />}
          <span>{workspace?.name ? `工作区 · ${workspace.name}` : "工作区文件"}</span>
          {isSandbox && <span style={{ fontSize: 12, color: "var(--gray-400)" }}>未连接</span>}
        </span>
      }
      placement="right"
      width={Math.min(560, window.innerWidth - 48)}
      open={open}
      onClose={onClose}
      styles={{ body: { padding: 0 } }}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {isSandbox ? (
          /* Sandbox placeholder — no real filesystem backend this iteration. */
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: "var(--gray-400)" }}>
                  📦 沙盒环境尚未接入，暂不可查看文件
                </span>
              }
            />
          </div>
        ) : (
          <>
        {/* Toolbar: scope switch + file actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--gray-150)" }}>
          <Tooltip title="对话输出">
            <Button
              size="small"
              type={scope === "outputs" ? "primary" : "text"}
              disabled={scope === "outputs"}
              onClick={() => setScope("outputs")}
            >
              对话输出
            </Button>
          </Tooltip>
          <Tooltip title="整个工作区">
            <Button
              size="small"
              type={scope === "root" ? "primary" : "text"}
              disabled={scope === "root"}
              onClick={() => setScope("root")}
            >
              工作区
            </Button>
          </Tooltip>
          <div style={{ width: 1, height: 16, background: "var(--gray-150)", marginInline: 4 }} />
          <Upload {...uploadProps}>
            <Tooltip title="上传文件">
              <Button size="small" type="text" icon={<UploadOutlined />} />
            </Tooltip>
          </Upload>
          <Tooltip title="新建文件夹">
            <Button size="small" type="text" icon={<FolderAddOutlined />} onClick={() => setNewFolderOpen(true)} />
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Tooltip title="刷新">
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={loadTree} />
          </Tooltip>
        </div>

        {/* Breadcrumb — current location inside the workspace. */}
        <div style={{ padding: "5px 12px", borderBottom: "1px solid var(--gray-100)", fontSize: 12, color: "var(--gray-500)" }}>
          <Breadcrumb
            items={[
              {
                title: (
                  <a onClick={() => { setCwd(""); setSelected(null); setFile(null); }}>
                    <HomeOutlined style={{ marginRight: 4 }} />
                    {scope === "outputs" ? "对话输出" : workspace?.name ?? "工作区"}
                  </a>
                ),
              },
              ...crumbs.map((c) => ({
                title: <a onClick={() => { setCwd(c.path); setSelected(null); setFile(null); }}>{c.name}</a>,
              })),
            ]}
          />
        </div>

        {/* Tree + preview split */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Left: file tree */}
          <div style={{ width: 230, borderRight: "1px solid var(--gray-150)", overflow: "auto", flexShrink: 0 }}>
            {loadingTree ? (
              <div style={{ padding: 24, textAlign: "center" }}><Spin /></div>
            ) : entries.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--gray-400)", fontSize: 12 }}>
                暂无文件
              </div>
            ) : (
              <Tree
                treeData={treeData}
                blockNode
                onSelect={onTreeSelect}
                selectedKeys={selected ? [selected.path] : []}
              />
            )}
          </div>

          {/* Right: preview (per-file actions now live on the tree node menu). */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, overflow: "auto" }}>
              <FilePreview
                file={file}
                blobUrl={blobUrl}
                loading={loadingFile}
                fullHeight
                onSave={selected ? handleSave : undefined}
                onDownload={selected ? handleDownload : undefined}
              />
            </div>
          </div>
        </div>

        {/* New folder modal */}
        <Modal
          title="新建文件夹"
          open={newFolderOpen}
          onCancel={() => setNewFolderOpen(false)}
          onOk={createFolder}
          okText="创建"
          cancelText="取消"
          destroyOnClose
        >
          <Input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="文件夹名称"
            autoFocus
            maxLength={80}
            style={{ marginTop: 8 }}
          />
        </Modal>
          </>
        )}
      </div>
    </Drawer>
  );
}
