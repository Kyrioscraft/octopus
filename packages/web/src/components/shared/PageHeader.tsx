import type { ReactNode } from "react";

/**
 * Shared chrome for the settings / extensions pages.
 *
 * These pages had byte-identical copies of a top-bar + icon-tile + title trio
 * each; they now import one definition. `PageHeader` is the newer, sticky
 * frosted variant used by the list pages — the style constants remain for the
 * detail/form pages, whose header is a bespoke flex row.
 */

/** Sticky, translucent page header with a hairline base. */
export function PageHeader({
  title,
  subtitle,
  icon,
  leading,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional tile icon before the title. */
  icon?: ReactNode;
  /** Optional leading control (e.g. a back button). */
  leading?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      {leading}
      {icon && <span className="page-header-icon">{icon}</span>}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span
          className="truncate"
          style={{
            fontWeight: 600,
            fontSize: "var(--text-md)",
            letterSpacing: "-0.01em",
            color: "var(--gray-1000)",
          }}
        >
          {title}
        </span>
        {subtitle && (
          <span className="truncate" style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            {subtitle}
          </span>
        )}
      </div>
      <div style={{ flex: 1 }} />
      {actions && <div style={{ display: "flex", alignItems: "center", gap: 6 }}>{actions}</div>}
    </div>
  );
}

/** Detail/form page top bar (leading back button + tile + title + actions). */
export const topBarStyle: React.CSSProperties = {
  height: "var(--header-h)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "0 20px",
  borderBottom: "1px solid var(--border-subtle)",
  flexShrink: 0,
  background: "var(--bg-canvas)",
};

export const iconTileStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-muted)",
  color: "var(--text-secondary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 16,
  flexShrink: 0,
};

export const titleStyle: React.CSSProperties = {
  fontSize: "var(--text-md)",
  fontWeight: 600,
  letterSpacing: "-0.01em",
  color: "var(--gray-1000)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const subtitleStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-tertiary)",
  marginTop: 2,
};

export const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "var(--radius-xs)",
  color: "var(--text-secondary)",
};