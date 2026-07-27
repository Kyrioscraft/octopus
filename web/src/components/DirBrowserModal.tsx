import { useCallback, useEffect, useState } from "react";
import { Modal, Breadcrumb, Spin, Button, Tooltip, message as antdMessage } from "antd";
import {
  FolderOpenOutlined,
  FolderOutlined,
  ArrowLeftOutlined,
  HomeOutlined,
  CheckOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { OctopusClient, type HostBrowseResult, type HostDirEntry } from "@octopus/tentacle";

// =============================================================================
// DirBrowserModal — host directory picker for binding a real workspace path.
//
// The browser cannot read the host filesystem, so this lists server-side
// directories (constrained to OCTOPUS_WORKSPACE_BROWSABLE_ROOTS) and lets the
// user navigate into a folder. On confirm, the selected absolute path is
// returned to the caller, which binds it as the workspace's rootDir.
// =============================================================================

const sdk = new OctopusClient();

export interface DirBrowserModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen absolute directory path. */
  onSelect: (path: string) => void;
}

export function DirBrowserModal({ open, onClose, onSelect }: DirBrowserModalProps) {
  const [data, setData] = useState<HostBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    try {
      const res = await sdk.browseHostDirs(path);
      setData(res);
      // Default-select the listed directory so the user can confirm immediately.
      setSelected(res.current);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "加载目录失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      // On open, list the default root (or the current dir if already loaded).
      load(data?.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Breadcrumb segments from each browsable root down to the current dir.
  const crumbs = (() => {
    if (!data) return [];
    // Find which root the current path is under.
    const root = data.roots.find((r) => data.current === r || data.current.startsWith(r + "\\") || data.current.startsWith(r + "/"));
    const base = root ?? data.current;
    const rel = data.current.slice(base.length).replace(/^[\\/]+/, "");
    const segs = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    const items = [{ name: root ? root.split(/[\\/]/).pop() || root : "根", path: base }];
    let acc = base;
    for (const s of segs) {
      acc = acc + (acc.endsWith("\\") || acc.endsWith("/") ? "" : "\\") + s;
      items.push({ name: s, path: acc });
    }
    return items;
  })();

  const enterDir = (path: string) => {
    setSelected(path);
    load(path);
  };

  const goUp = () => {
    if (!data) return;
    // Find parent that is still within a browsable root.
    const roots = data.roots;
    const cur = data.current;
    let parent = cur.replace(/[\\/][^\\/]+[\\/]?$/, "");
    if (parent === cur) return;
    // Stop at root boundary.
    const within = roots.some((r) => parent === r || parent.startsWith(r + "\\") || parent.startsWith(r + "/"));
    if (within) enterDir(parent);
  };

  const confirm = () => {
    if (!selected) {
      antdMessage.warning("请选择一个目录");
      return;
    }
    onSelect(selected);
    onClose();
  };

  return (
    <Modal
      title="选择工作区目录"
      open={open}
      onCancel={onClose}
      onOk={confirm}
      okText="选择此目录"
      cancelText="取消"
      width={560}
      destroyOnClose
    >
      {/* Root selector + up + reload */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Tooltip title={data && crumbs.length > 1 ? "上一级" : "已在根目录"}>
          <Button
            size="small" type="text" icon={<ArrowLeftOutlined />}
            disabled={!data || crumbs.length <= 1}
            onClick={goUp}
          />
        </Tooltip>
        {data && data.roots.length > 1 && (
          <select
            value={data.roots.find((r) => data.current === r || data.current.startsWith(r)) ?? ""}
            onChange={(e) => enterDir(e.target.value)}
            style={{ fontSize: 12, height: 28, borderRadius: 6, border: "1px solid var(--gray-150)", maxWidth: 200 }}
          >
            {data.roots.map((r) => (
              <option key={r} value={r}>{r.split(/[\\/]/).pop() || r}</option>
            ))}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <Tooltip title="刷新">
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => load(data?.current)} />
        </Tooltip>
      </div>

      {/* Current path + breadcrumb */}
      <div style={{ fontSize: 12, color: "var(--gray-500)", marginBottom: 8, wordBreak: "break-all" }}>
        <Breadcrumb
          items={[
            {
              title: (
                <span onClick={() => data && enterDir(data.roots[0])} style={{ cursor: "pointer" }}>
                  <HomeOutlined />
                </span>
              ),
            },
            ...crumbs.map((c) => ({
              title: <span onClick={() => enterDir(c.path)} style={{ cursor: "pointer" }}>{c.name}</span>,
            })),
          ]}
        />
      </div>

      {/* Directory list */}
      <div style={{
        border: "1px solid var(--gray-150)", borderRadius: 8,
        height: 320, overflow: "auto", background: "var(--gray-25)",
      }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center" }}><Spin /></div>
        ) : !data || data.entries.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--gray-400)", fontSize: 13 }}>
            该目录下没有子目录
          </div>
        ) : (
          data.entries.map((e: HostDirEntry) => (
            <div
              key={e.path}
              onClick={() => setSelected(e.path)}
              onDoubleClick={() => enterDir(e.path)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "0 12px", height: 34, cursor: "pointer", fontSize: 13,
                background: selected === e.path ? "color-mix(in srgb, var(--main-color) 8%, transparent)" : "transparent",
                color: selected === e.path ? "var(--main-color)" : "var(--gray-700)",
                fontWeight: selected === e.path ? 600 : 400,
              }}
            >
              <FolderOutlined style={{ color: "var(--main-color)" }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.name}
              </span>
              {selected === e.path && <CheckOutlined style={{ fontSize: 12 }} />}
            </div>
          ))
        )}
      </div>

      {/* Selected path preview */}
      <div style={{
        marginTop: 8, padding: "6px 10px", fontSize: 12,
        background: "var(--gray-25)", borderRadius: 6, color: "var(--gray-600)",
        fontFamily: "'JetBrains Mono', Consolas, monospace", wordBreak: "break-all",
      }}>
        <FolderOpenOutlined style={{ marginRight: 6, color: "var(--main-color)" }} />
        {selected ?? "未选择"}
      </div>
    </Modal>
  );
}
