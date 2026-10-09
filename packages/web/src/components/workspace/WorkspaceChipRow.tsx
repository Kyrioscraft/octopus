import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown, message as antdMessage } from "antd";
import { Check, ChevronDown, Folder, FolderOpen, Plus } from "lucide-react";
import { OctopusClient, type Workspace } from "@octopus/tentacle";
import { useChatStore } from "../../stores/chat.js";
import { DirBrowserModal } from "./DirBrowserModal.js";

// =============================================================================
// WorkspaceChipRow — the hero workspace selector row (deepseek-harness style).
//
// Sits between the greeting and the composer on the start screen. The chip is
// a quiet text button (folder icon + label + chevron, transparent background
// that fills on hover/open). Clicking it opens a flat menu of workspace names
// (no paths) with a ✓ on the active one and a pinned "添加工作区…" action below
// a hairline divider. With NO workspaces at all, clicking skips the menu and
// opens the directory browser directly — an empty menu adds nothing but a
// click.
//
// Picking a workspace only sets `activeWorkspaceId`: the start screen's send
// path already binds new threads to it, so no further wiring is needed. The
// sidebar keeps its own full management UI (open/remove); this row is the
// conversation-entry shortcut.
// =============================================================================

/** The chip trigger: closed folder + placeholder when nothing is selected,
 *  open folder + name once a workspace is active. */
function ChipTrigger({
  label,
  open,
  onClick,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="focus-ring"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: 360,
        minHeight: 28,
        padding: "0 8px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: open ? "var(--bg-muted)" : "transparent",
        color: "var(--text-primary)",
        fontFamily: "inherit",
        fontSize: "var(--text-sm)",
        lineHeight: "20px",
        fontWeight: 500,
        cursor: "pointer",
        transition: "background-color var(--dur-1) var(--ease)",
      }}
      onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "var(--bg-muted)"; }}
      onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
    >
      {open
        ? <FolderOpen size={16} style={{ flexShrink: 0 }} />
        : <Folder size={16} style={{ flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <ChevronDown size={12} style={{ flexShrink: 0, color: "var(--text-tertiary)" }} />
    </button>
  );
}

const sdk = new OctopusClient();

export function WorkspaceChipRow({
  /** Optional window-event name that opens the picker — the dashed composer
   *  card sits in a sibling subtree, so Chat.tsx forwards its clicks here. */
  pickerOpenEvent,
}: {
  pickerOpenEvent?: string;
}) {
  const workspaces = useChatStore((s) => s.workspaces);
  const setWorkspaces = useChatStore((s) => s.setWorkspaces);
  const activeWorkspaceId = useChatStore((s) => s.activeWorkspaceId);
  const setActiveWorkspaceId = useChatStore((s) => s.setActiveWorkspaceId);

  const [menuOpen, setMenuOpen] = useState(false);
  // Re-entrancy guard for the native dialog: the chip click, the window event
  // and the menu item can all fire in one interaction — a second spawn would
  // stack a second OS dialog on the first.
  const pickingRef = useRef(false);
  // The OS-native dialog is the primary path (deepseek-harness style); the
  // in-app DirBrowserModal stays as the fallback for hosts where the server
  // can't show a dialog (headless / remote server deployments).
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );

  /** Open Folder — same flow as the sidebar: bind the host directory (dedupe +
   *  un-hide happen server-side), refresh the list, select the new row. */
  const openFolder = useCallback(async (hostPath: string) => {
    try {
      const ws = await sdk.openWorkspace(hostPath);
      setWorkspaces(await sdk.listWorkspaces());
      setActiveWorkspaceId(ws.id);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "打开目录失败");
    }
  }, [setWorkspaces, setActiveWorkspaceId]);

  /** Show the native OS folder dialog via the local server and adopt the
   *  picked path. Falls back to the in-app browser modal when the dialog can't
   *  be shown (remote/headless host). User cancel is silent. */
  const pickDirectory = useCallback(async () => {
    if (pickingRef.current) return; // one dialog at a time
    pickingRef.current = true;
    setMenuOpen(false);
    try {
      const path = await sdk.pickHostDirectory();
      await openFolder(path);
    } catch (err: any) {
      // The client raises a generic Error whose message is the server's
      // `message` field — the cancel path is distinguished by text.
      if (err?.message === "已取消选择") return;
      setDirBrowserOpen(true);
    } finally {
      pickingRef.current = false;
    }
  }, [openFolder]);

  // Sibling-subtree trigger (dashed composer card, suggestion cards): both
  // route their clicks through this window event. pickDirectory's re-entrancy
  // guard makes double dispatch (card click + event) harmless.
  useEffect(() => {
    if (!pickerOpenEvent) return;
    const handler = () => {
      if (workspaces.length === 0) void pickDirectory();
      else setMenuOpen(true);
    };
    window.addEventListener(pickerOpenEvent, handler);
    return () => window.removeEventListener(pickerOpenEvent, handler);
  }, [pickerOpenEvent, workspaces.length, pickDirectory]);

  const pick = useCallback((ws: Workspace) => {
    setMenuOpen(false);
    setActiveWorkspaceId(ws.id);
  }, [setActiveWorkspaceId]);

  const onChipClick = () => {
    // Empty-list special case (dsh behaviour): go straight to the OS folder
    // dialog instead of an empty menu. The Dropdown trigger must stay closed —
    // otherwise it pops a menu with only 添加工作区… next to the dialog, and a
    // second click there spawns a SECOND native dialog.
    if (workspaces.length === 0) {
      void pickDirectory();
      return;
    }
    setMenuOpen((v) => !v);
  };

  // Programmatic opens (window event) must not toggle back closed via
  // onOpenChange before the user interacts — keep it one-way from the API.
  const onDropdownOpenChange = useCallback((o: boolean) => {
    setMenuOpen((prev) => (prev === o ? prev : o));
  }, []);

  const label = activeWorkspace ? activeWorkspace.name : "选择工作区";

  return (
    <div style={{ display: "flex", justifyContent: "flex-start", padding: "2px 0 6px", textAlign: "left" }}>
      <Dropdown
        open={menuOpen && workspaces.length > 0}
        onOpenChange={(o) => { if (workspaces.length > 0) onDropdownOpenChange(o); }}
        trigger={["click"]}
        placement="bottomLeft"
        // The popup is fully custom (dsh menu card): flat name list, ✓ on the
        // active row, hairline divider, pinned add action.
        popupRender={() => (
          <div
            style={{
              width: 260,
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-lg)",
              padding: 4,
            }}
          >
            {workspaces.map((ws) => {
              const active = ws.id === activeWorkspaceId;
              return (
                <div
                  key={ws.id}
                  className={`ui-row focus-ring${active ? " is-active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => pick(ws)}
                  style={{ minHeight: 34, gap: 6, padding: "0 8px", marginBottom: 1 }}
                >
                  <Folder size={16} style={{ flexShrink: 0 }} />
                  <span className="truncate" style={{ flex: 1 }}>{ws.name}</span>
                  {active && <Check size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />}
                </div>
              );
            })}
            <div style={{ height: 1, background: "var(--border-subtle)", margin: "4px 8px" }} />
            <div
              className="ui-row focus-ring"
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); void pickDirectory(); }}
              style={{ minHeight: 34, gap: 6, padding: "0 8px" }}
            >
              <Plus size={16} style={{ flexShrink: 0 }} />
              <span className="truncate" style={{ flex: 1 }}>添加工作区…</span>
            </div>
          </div>
        )}
      >
        <div>
          <ChipTrigger label={label} open={menuOpen} onClick={onChipClick} />
        </div>
      </Dropdown>
      <DirBrowserModal
        open={dirBrowserOpen}
        onClose={() => setDirBrowserOpen(false)}
        onSelect={(path) => { void openFolder(path); }}
      />
    </div>
  );
}
