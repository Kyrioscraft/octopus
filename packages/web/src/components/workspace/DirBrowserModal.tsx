import { useCallback, useEffect, useState } from "react";
import { Modal, Breadcrumb, Spin, Button, Tooltip, Select, message as antdMessage } from "antd";
import {
  ArrowLeft,
  Check,
  Folder,
  Home,
  RotateCw,
} from "lucide-react";
import { OctopusClient, type HostBrowseResult, type HostDirEntry } from "@octopus/tentacle";

// =============================================================================
// DirBrowserModal — host directory picker for binding a real workspace path.
//
// The browser cannot read the host filesystem, so this lists server-side
// directories (constrained to OCTOPUS_WORKSPACE_BROWSABLE_ROOTS) and lets the
// user navigate into a folder. On confirm, the selected absolute path is
// returned to the caller, which binds it as the workspace's rootDir.
// =============================================================================

// =============================================================================
// Path helpers — robust against trailing separators on Windows drive roots.
// A browsable root like "C:\" already ends with a backslash, so the naive
// `current.startsWith(root + "\\")` produces "C:\\" and never matches a real
// path such as "C:\Users". We normalize by stripping trailing separators before
// comparing, and accept both "\" and "/" as the boundary.
// =============================================================================

/** Strip trailing path separators (both "\" and "/") from a path. */
function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "") || p;
}

/**
 * Find the browsable root that contains or equals `current`. Returns the
 * matched root (in its original form) or undefined.
 */
function findContainingRoot(current: string, roots: string[]): string | undefined {
  const curNorm = stripTrailingSep(current);
  return roots.find((r) => {
    // POSIX-style root is a bare separator ("/" or "\"); match any absolute path.
    if (/^[\\/]+$/.test(r)) return /^[\\/]/.test(curNorm);
    const rootNorm = stripTrailingSep(r);
    if (rootNorm === "") return false;
    return curNorm === rootNorm
      || curNorm.startsWith(rootNorm + "\\")
      || curNorm.startsWith(rootNorm + "/");
  });
}

/** Whether `current` is exactly a top-level browsable root (no parent to go up to). */
function isAtRoot(current: string, roots: string[]): boolean {
  const curNorm = stripTrailingSep(current);
  // POSIX root "/" (or "\") normalizes to empty — treat as at-root.
  if (curNorm === "") return roots.some((r) => /^[\\/]+$/.test(r));
  return roots.some((r) => stripTrailingSep(r) === curNorm);
}

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
    // Find which root the current path is under (robust to trailing separators).
    const root = findContainingRoot(data.current, data.roots);
    if (!root) return [{ name: data.current.split(/[\\/]/).pop() || data.current, path: data.current }];
    // Use the separator-stripped forms so slicing/accumulation are predictable.
    const baseNorm = stripTrailingSep(root);
    const curNorm = stripTrailingSep(data.current);
    const rel = curNorm.slice(baseNorm.length).replace(/^[\\/]+/, "");
    const segs = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    // First crumb is the root label (drive letter on Windows, "/" on POSIX).
    const rootLabel = baseNorm.split(/[\\/]/).pop() || baseNorm;
    const items = [{ name: rootLabel, path: data.current === root ? root : baseNorm }];
    let acc = baseNorm;
    for (const s of segs) {
      acc = acc + "\\" + s;
      // On the last segment, point to the real current path so selection state matches.
      items.push({ name: s, path: s === segs[segs.length - 1] ? data.current : acc });
    }
    return items;
  })();

  const enterDir = (path: string) => {
    setSelected(path);
    load(path);
  };

  const goUp = () => {
    if (!data) return;
    if (isAtRoot(data.current, data.roots)) return; // already at a browsable root
    // Drop the last path segment to get the parent.
    const parent = stripTrailingSep(data.current).replace(/[\\/][^\\/]+$/, "");
    // Only navigate if the parent is still within (or equals) a browsable root.
    if (findContainingRoot(parent, data.roots)) enterDir(parent);
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
      destroyOnHidden
    >
      {/* Toolbar: navigation (up + root switch) on the left, refresh on the right */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {/* Left group: navigation */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button
            size="small"
            icon={<ArrowLeft />}
            disabled={!data || isAtRoot(data.current, data.roots)}
            onClick={goUp}
            style={{ borderRadius: 6, height: 30, fontSize: 13, borderColor: "var(--gray-150)" }}
          >
            上一级
          </Button>
          {data && data.roots.length > 1 && (
            <Select
              size="small"
              value={data.roots.find((r) => data.current === r || data.current.startsWith(r)) ?? data.roots[0]}
              onChange={(v) => enterDir(v)}
              style={{ width: 130 }}
              options={data.roots.map((r) => ({
                value: r,
                label: r.split(/[\\/]/).pop() || r,
              }))}
            />
          )}
        </div>

        {/* Right group: refresh */}
        <div style={{ flex: 1 }} />
        <Tooltip title="刷新">
          <Button size="small" type="text" icon={<RotateCw />} onClick={() => load(data?.current)} />
        </Tooltip>
      </div>

      {/* Current path + breadcrumb */}
      <div style={{ fontSize: 12, color: "var(--gray-500)", marginBottom: 8, wordBreak: "break-all" }}>
        <Breadcrumb
          items={[
            {
              title: (
                <span onClick={() => data && enterDir(data.roots[0])} style={{ cursor: "pointer" }}>
                  <Home />
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
        border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)",
        height: 320, overflow: "auto", background: "var(--bg-elevated)", padding: 4,
      }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center" }}><Spin /></div>
        ) : !data || data.entries.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: "var(--text-sm)" }}>
            该目录下没有子目录
          </div>
        ) : (
          data.entries.map((e: HostDirEntry) => {
            const isSelected = selected === e.path;
            return (
              <div
                key={e.path}
                onClick={() => setSelected(e.path)}
                onDoubleClick={() => enterDir(e.path)}
                className={`ui-row focus-ring${isSelected ? " is-active" : ""}`}
                role="button"
                tabIndex={0}
                style={{ padding: "0 10px", height: 34, marginBottom: 2 }}
              >
                <Folder style={{ color: isSelected ? "var(--accent)" : "var(--text-tertiary)" }} />
                <span className="truncate" style={{ flex: 1 }}>
                  {e.name}
                </span>
                {isSelected && <Check style={{ fontSize: 12 }} />}
              </div>
            );
          })
        )}
      </div>

      {/* Selected basename hint (lightweight — full path is shown in the breadcrumb) */}
      <div style={{
        marginTop: 8, fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
      }}>
        {selected
          ? <>已选：<span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{selected.split(/[\\/]/).pop() || selected}</span></>
          : "未选择"}
      </div>
    </Modal>
  );
}
