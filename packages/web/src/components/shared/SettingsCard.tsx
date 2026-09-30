import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { RotateCw } from "lucide-react";

/**
 * Shared card used by Settings sections and Extensions pages: bordered
 * container with a titled header row (the "常规配置界面" look).
 *
 * Flat by design — it sits inside the app's content card, so it carries a border
 * and radius but no elevation. Shape comes from the shared `.panel` class.
 */
export function SettingsCard({
  title,
  extra,
  children,
}: {
  title: string;
  /** Optional right-side node in the header row (e.g. count, action). */
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="panel">
      <div
        style={{
          padding: "13px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          fontSize: "var(--text-base)",
          fontWeight: 600,
          color: "var(--gray-1000)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>{title}</span>
        {extra}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

/**
 * One list row inside a SettingsCard, mirroring the settings tool-toggle
 * row: leading icon tile, title/description, trailing control.
 *
 * Layout and the inter-row hairline come from `.settings-row` /
 * `.settings-rows` (theme.css) — the row must not set its own `border-bottom`,
 * or the list gets a divider under the last item.
 */
export function SettingsRow({
  icon,
  title,
  description,
  meta,
  children,
  onClick,
  disabled,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Extra inline node between description and trailing control (e.g. Tag). */
  meta?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={`settings-row${onClick ? " focus-ring" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{
        cursor: onClick ? "pointer" : "default",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon && <span className="settings-row-icon">{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-base)",
            fontWeight: 500,
            color: "var(--gray-1000)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
          {meta}
        </div>
        {description && (
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              lineHeight: 1.5,
              // String descriptions clamp to one line; element descriptions
              // (e.g. multi-line clamped spans) manage their own overflow.
              overflow: "hidden",
              textOverflow: typeof description === "string" ? "ellipsis" : undefined,
              whiteSpace: typeof description === "string" ? "nowrap" : "normal",
              marginTop: 3,
            }}
          >
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** Label/value row used in detail info cards. */
export function InfoRow({
  label,
  value,
  mono,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** Optional right-side action node (e.g. edit button). */
  action?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: "var(--text-sm)", padding: "6px 0" }}>
      <span style={{ color: "var(--text-tertiary)", flexShrink: 0, width: 100 }}>
        {label}
      </span>
      <span
        style={{
          color: "var(--gray-800)",
          wordBreak: "break-all",
          whiteSpace: mono ? "pre-wrap" : "normal",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </span>
      {action ? <span style={{ marginLeft: "auto", flexShrink: 0 }}>{action}</span> : null}
    </div>
  );
}

/** Rows container for SettingsRow lists inside a SettingsCard. The hairline
 * between rows is drawn by `.settings-rows > .settings-row + .settings-row`
 * (theme.css), so the last row has no trailing divider. */
export function SettingsRows({ children }: { children: React.ReactNode }) {
  return <div className="settings-rows">{children}</div>;
}

/** Shared toolbar for extensions list pages. Icon order: 新增/其他 actions
 * first (children), then reload last. */
export function ListToolbar({
  loading,
  onReload,
  children,
}: {
  loading: boolean;
  onReload: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
      {children}
      <Tooltip title="刷新">
        <button
          type="button"
          className="icon-btn focus-ring"
          aria-label="刷新"
          onClick={onReload}
          style={{ width: 28, height: 28 }}
        >
          <span style={{ display: "flex", fontSize: 15 }}>
            <RotateCw className={loading ? "lucide-spin" : undefined} />
          </span>
        </button>
      </Tooltip>
    </div>
  );
}
