import type { ReactNode } from "react";
import { Button, Tooltip } from "antd";
import { RotateCw } from "lucide-react";

/**
 * Shared card used by Settings sections and Extensions pages: bordered
 * container with a titled header row (the "常规配置界面" look).
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
    <div
      style={{
        background: "var(--gray-0)",
        border: "1px solid var(--gray-150)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--gray-100)",
          fontSize: 14,
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
 * row: leading icon, title/description, trailing control.
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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 0",
        borderBottom: "1px solid var(--gray-100)",
        cursor: onClick ? "pointer" : "default",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon && (
        <span
          style={{
            fontSize: 18,
            color: "var(--main-color)",
            width: 24,
            textAlign: "center",
            flexShrink: 0,
            display: "inline-flex",
            justifyContent: "center",
          }}
        >
          {icon}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
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
              fontSize: 12,
              color: "var(--gray-500)",
              // String descriptions clamp to one line; element descriptions
              // (e.g. multi-line clamped spans) manage their own overflow.
              overflow: "hidden",
              textOverflow: typeof description === "string" ? "ellipsis" : undefined,
              whiteSpace: typeof description === "string" ? "nowrap" : "normal",
              marginTop: 2,
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
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "5px 0" }}>
      <span style={{ color: "var(--gray-500)", flexShrink: 0, width: 100 }}>
        {label}
      </span>
      <span
        style={{
          color: "var(--gray-800)",
          wordBreak: "break-all",
          whiteSpace: mono ? "pre-wrap" : "normal",
          fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
        }}
      >
        {value}
      </span>
      {action ? <span style={{ marginLeft: "auto", flexShrink: 0 }}>{action}</span> : null}
    </div>
  );
}

/** Rows container for SettingsRow lists inside a SettingsCard: removes the
 * last row's bottom divider. */
export function SettingsRows({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`.settings-rows > *:last-child { border-bottom: none; }`}</style>
      <div className="settings-rows" style={{ display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </>
  );
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
        <Button
          type="text"
          size="small"
          icon={<RotateCw className={loading ? "lucide-spin" : undefined} />}
          onClick={onReload}
          style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
        />
      </Tooltip>
    </div>
  );
}
