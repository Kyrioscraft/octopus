import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Tree, Spin, Tooltip, Button, Dropdown, Empty, message as antdMessage,
} from "antd";
import type { TreeDataNode, MenuProps } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  ReloadOutlined,
  DownloadOutlined,
  DeleteOutlined,
  MoreOutlined,
} from "@ant-design/icons";
import {
  OctopusClient,
  type WorkspaceEntry,
  type WorkspaceFileContent,
} from "@octopus/tentacle";
import { FilePreview } from "./FilePreview.js";
import { useChatStore } from "../stores/chat.js";

// =============================================================================
// WorkspaceFileTree — right-side, always-on file explorer for the active
// workspace (IDE resource-explorer style). Lazy-loads subdirectories, shows a
// preview pane when a file is selected. Replaces the old in-conversation
// drawer as the primary file-viewing surface.
// =============================================================================

const sdk = new OctopusClient();

export function WorkspaceFileTree() {
  const { workspaces, activeWorkspaceId } = useChatStore();
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const [expanded, setExpanded] = useState<React.Key[]>([]);
  const [treeData, setTreeData] = useState<TreeDataNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const isSandbox = activeWorkspace?.environment === "sandbox";

  // Load a directory level and merge it into the tree by path.
  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const items = await sdk.getWorkspaceTree(activeWorkspaceId!, dirPath || undefined);
      return items;
    } catch {
      return [];
    }
  }, [activeWorkspaceId]);

  // Build a tree from a flat level listing, merging into existing children.
  const mergeLevel = useCallback((items: WorkspaceEntry[], parentPath: string) => {
    setTreeData((prev) => {
      const build = (nodes: TreeDataNode[]): TreeDataNode[] => {
        return nodes.map((n) => {
          // Match by key (path). For dirs, lazily attach children.
          if (n.key === parentPath) {
            const children: TreeDataNode[] = items.map((e) => ({
              key: e.path,
              title: e.name,
              isLeaf: !e.isDir,
            }));
            return { ...n, children };
          }
          if (n.children) return { ...n, children: build(n.children) };
          return n;
        });
      };
      // parentPath "" = root → replace the whole tree.
      if (parentPath === "" || parentPath == null) {
        return items.map((e) => ({
          key: e.path,
          title: e.name,
          isLeaf: !e.isDir,
        }));
      }
      return build(prev);
    });
  }, []);

  const loadRoot = useCallback(async () => {
    if (!activeWorkspaceId) { setTreeData([]); return; }
    setLoading(true);
    try {
      const items = await loadDir("");
      mergeLevel(items, "");
    } finally {
      setLoading(false);
    }
  }, [activeWorkspaceId, loadDir, mergeLevel]);

  useEffect(() => {
    setSelected(null); setFile(null);
    loadRoot();
  }, [activeWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke blob URL on change/unmount.
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  const onExpand = useCallback(async (keys: React.Key[], info: any) => {
    setExpanded(keys);
    const node = info.node as TreeDataNode;
    // When expanding a dir whose children aren't loaded yet, fetch them.
    if (info.expanded && node && !node.children) {
      const items = await loadDir(String(node.key));
      mergeLevel(items, String(node.key));
    }
  }, [loadDir, mergeLevel]);

  const onSelect = useCallback(async (keys: React.Key[]) => {
    const key = keys[0] as string | undefined;
    if (!key || !activeWorkspaceId) return;
    // Find the entry name from tree; build a lightweight entry.
    const name = key.split("/").pop() ?? key;
    const entry: WorkspaceEntry = { name, path: key, isDir: false, size: 0, modifiedAt: "" };
    setSelected(entry);
    setFileLoading(true); setFile(null);
    if (blobUrl) { URL.revokeObjectURL(blobUrl); setBlobUrl(null); }
    try {
      const content = await sdk.getWorkspaceFile(activeWorkspaceId, key);
      setFile(content);
      if (content.previewType === "image" || content.previewType === "pdf") {
        const blob = await sdk.downloadWorkspaceFile(activeWorkspaceId, key);
        setBlobUrl(URL.createObjectURL(blob));
      }
    } catch (err: any) {
      antdMessage.error(err?.message ?? "加载文件失败");
    } finally {
      setFileLoading(false);
    }
  }, [activeWorkspaceId, blobUrl]);

  const handleDownload = useCallback(async (entry: WorkspaceEntry) => {
    if (!activeWorkspaceId) return;
    try {
      const blob = await sdk.downloadWorkspaceFile(activeWorkspaceId, entry.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = entry.name; a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "下载失败");
    }
  }, [activeWorkspaceId]);

  const handleDelete = useCallback(async (entry: WorkspaceEntry) => {
    if (!activeWorkspaceId) return;
    try {
      await sdk.deleteWorkspacePath(activeWorkspaceId, entry.path);
      antdMessage.success("已删除");
      if (selected?.path === entry.path) { setSelected(null); setFile(null); }
      loadRoot();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "删除失败");
    }
  }, [activeWorkspaceId, selected, loadRoot]);

  const handleSave = useCallback(async (content: string) => {
    if (!activeWorkspaceId || !selected) return;
    await sdk.saveWorkspaceFile(activeWorkspaceId, selected.path, content);
    setFile((f) => (f ? { ...f, content } : f));
  }, [activeWorkspaceId, selected]);

  // Per-file action menu (attached as the tree node's title suffix would be
  // noisy; instead show actions on the selected file in the preview header).
  const entryMenu = useCallback((e: WorkspaceEntry): MenuProps["items"] => [
    {
      key: "download", icon: <DownloadOutlined />, label: "下载",
      onClick: () => handleDownload(e),
    },
    {
      key: "delete", icon: <DeleteOutlined />, danger: true, label: "删除",
      onClick: () => handleDelete(e),
    },
  ], [handleDownload, handleDelete]);

  // Render with folder/file icons.
  const decoratedTree = useMemo(() => {
    const decorate = (nodes: TreeDataNode[]): TreeDataNode[] =>
      nodes.map((n) => {
        const isLeaf = (n as any).isLeaf !== false && !(n as any).children?.length;
        return {
          ...n,
          icon: isLeaf ? <FileOutlined /> : <FolderOutlined style={{ color: "var(--main-color)" }} />,
          children: n.children ? decorate(n.children) : undefined,
        };
      });
    return decorate(treeData);
  }, [treeData]);

  if (!activeWorkspace) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--gray-400)", fontSize: 13, padding: 16, textAlign: "center" }}>
        打开一个文件夹后<br />此处显示工作区文件
      </div>
    );
  }

  if (isSandbox) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span style={{ color: "var(--gray-400)" }}>📦 沙盒环境尚未接入，暂不可查看文件</span>}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px", borderBottom: "1px solid var(--gray-150)", flexShrink: 0,
      }}>
        <FolderOutlined style={{ color: "var(--main-color)" }} />
        <Tooltip title={activeWorkspace.path}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {activeWorkspace.name}
          </span>
        </Tooltip>
        <Tooltip title="刷新">
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={loadRoot} />
        </Tooltip>
        {selected && (
          <Dropdown menu={{ items: entryMenu(selected) }} trigger={["click"]}>
            <Button size="small" type="text" icon={<MoreOutlined />} />
          </Dropdown>
        )}
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflow: "auto", minHeight: 200, padding: "4px 4px" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center" }}><Spin /></div>
        ) : treeData.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--gray-400)", fontSize: 12 }}>
            暂无文件
          </div>
        ) : (
          <Tree
            treeData={decoratedTree}
            showIcon
            blockNode
            expandedKeys={expanded}
            onExpand={onExpand}
            onSelect={onSelect}
            selectedKeys={selected ? [selected.path] : []}
          />
        )}
      </div>

      {/* Preview */}
      {selected && (
        <div style={{
          height: "45%", borderTop: "1px solid var(--gray-150)", flexShrink: 0,
          display: "flex", flexDirection: "column",
        }}>
          <FilePreview
            file={file}
            blobUrl={blobUrl}
            loading={fileLoading}
            fullHeight
            onSave={handleSave}
            onDownload={() => handleDownload(selected)}
          />
        </div>
      )}
    </div>
  );
}
