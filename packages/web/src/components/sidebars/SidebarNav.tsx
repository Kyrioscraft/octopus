import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { IconButton } from "../widgets/IconButton.js";

/**
 * Shared sidebar primitives.
 *
 * The three sidebars (chat / settings / extensions) used to carry byte-identical
 * copies of their row and section-label styling with hand-written hover swaps.
 * They now share these two primitives over the `.ui-row` / `.section-label`
 * classes, so the navigation looks and behaves the same everywhere and stays
 * keyboard-navigable.
 */

/** A single navigation row. Collapses to an icon-only tile with a side tooltip. */
export function NavRow({
  icon,
  label,
  active = false,
  collapsed = false,
  onClick,
  trail,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  onClick?: () => void;
  /** Optional right-aligned content (counts, hover actions) — ignored when collapsed. */
  trail?: ReactNode;
}) {
  const row = (
    <div
      className={`ui-row focus-ring${active ? " is-active" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={collapsed ? { justifyContent: "center", padding: 0, height: 36 } : undefined}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          fontSize: 16,
          flexShrink: 0,
          color: active ? "var(--accent)" : "var(--text-tertiary)",
        }}
      >
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
            {label}
          </span>
          {trail}
        </>
      )}
    </div>
  );

  return collapsed ? (
    <Tooltip title={label} placement="right">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

/** Sidebar section heading ("工作区", "任务", …). */
export function SectionLabel({ children, collapsed = false }: { children: ReactNode; collapsed?: boolean }) {
  if (collapsed) return <div style={{ height: 10 }} />;
  // Layout — not padding — creates the section gap, and the wrapper is a flex box
  // with *symmetric* margins so the label's box centre is the row's centre axis: an
  // icon sharing the row centres on the same axis. Two effects used to push the text
  // 5.5px below that axis: an asymmetric `14px 0 6px` inset (the wrapper's content box
  // sat 4px below its margin-box centre, which is what `align-items: center` centres)
  // and the wrapper's own 21px line box (inherited 14px × 1.5) letting the 16px label
  // ride the baseline 1.5px lower still.
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        margin: "10px 0",
      }}
    >
      <span className="section-label">{children}</span>
    </div>
  );
}

/**
 * The sidebar used by /settings/* and /extensions/*: a back-to-chat affordance plus
 * a flat list of nav rows. Both routes share this because they differ only in the
 * label, the items and how the active key is derived.
 */
export function SectionSidebar({
  label,
  items,
  activeKey,
  collapsed = false,
}: {
  label: string;
  items: { key: string; path: string; icon: ReactNode; label: string }[];
  activeKey: string;
  collapsed?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: collapsed ? "12px 0 4px" : "12px 8px 4px",
          flexShrink: 0,
          display: "flex",
          justifyContent: collapsed ? "center" : "stretch",
        }}
      >
        {collapsed ? (
          <IconButton icon={<ArrowLeft />} title="返回对话" onClick={() => navigate("/")} />
        ) : (
          <button
            className="focus-ring"
            onClick={() => navigate("/")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              height: 34,
              padding: "0 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-default)",
              background: "var(--bg-elevated)",
              color: "var(--text-secondary)",
              fontSize: "var(--text-sm)",
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "background-color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease)",
            }}
          >
            <span style={{ display: "flex", fontSize: 15 }}>
              <ArrowLeft />
            </span>
            返回对话
          </button>
        )}
      </div>

      <SectionLabel collapsed={collapsed}>{label}</SectionLabel>

      <div style={{ padding: collapsed ? "0 8px 4px" : "0 8px 4px", flexShrink: 0 }}>
        {items.map((item) => (
          <div key={item.key} style={{ marginBottom: 2 }}>
            <NavRow
              icon={item.icon}
              label={item.label}
              active={activeKey === item.key}
              collapsed={collapsed}
              onClick={() => navigate(item.path)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}