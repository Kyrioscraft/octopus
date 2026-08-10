import type { ReactNode } from "react";
import { Tag } from "antd";

/**
 * Status dot color by level. Matches the app's semantic palette.
 */
const STATUS_COLORS: Record<string, string> = {
  success: "var(--main-color)",
  warning: "#faad14",
  error: "#ff4d4f",
  info: "var(--gray-400)",
};

export interface ExtensionTag {
  label: string;
  color?: string;
}

interface ExtensionCardProps {
  /** Leading icon node, rendered inside a 40×40 tile. */
  icon: ReactNode;
  title: string;
  /** Monospace subtitle under the title (e.g. transport, path). */
  subtitle?: string;
  description?: string;
  tags?: ExtensionTag[];
  /** Status dot + label shown top-right when no action is present. */
  statusLabel?: string;
  statusLevel?: "success" | "warning" | "error" | "info";
  /** Inline action button (e.g. 添加/启用). Mutually exclusive with status display. */
  actionLabel?: string;
  onAction?: () => void;
  /** Whole-card click (navigate to detail). */
  onClick?: () => void;
  /** Dimmed appearance for disabled/removed items. */
  disabled?: boolean;
}

/**
 * Reusable card for the extensions grid. Mirrors the yuxi InfoCard layout:
 * 40×40 icon tile + title/subtitle on the left, status/action on the right,
 * 2-line clamped description + tag row below.
 */
export function ExtensionCard({
  icon,
  title,
  subtitle,
  description,
  tags,
  statusLabel,
  statusLevel = "info",
  actionLabel,
  onAction,
  onClick,
  disabled,
}: ExtensionCardProps) {
  const clickable = !!onClick;
  const interactive = clickable || !!onAction;

  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 14,
        borderRadius: 10,
        border: "1px solid var(--gray-150)",
        background: "linear-gradient(45deg, var(--gray-0) 0%, var(--gray-25) 100%)",
        cursor: clickable ? "pointer" : "default",
        opacity: disabled ? 0.6 : 1,
        transition: "border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease",
        minHeight: 120,
      }}
      onMouseEnter={(e) => {
        if (!interactive) return;
        e.currentTarget.style.borderColor = "var(--main-100)";
        e.currentTarget.style.background =
          "linear-gradient(45deg, var(--gray-0) 0%, var(--main-30) 100%)";
      }}
      onMouseLeave={(e) => {
        if (!interactive) return;
        e.currentTarget.style.borderColor = "var(--gray-150)";
        e.currentTarget.style.background =
          "linear-gradient(45deg, var(--gray-0) 0%, var(--gray-25) 100%)";
      }}
    >
      {/* Header row: icon tile + title/subtitle + status/action */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: 8,
            background: "var(--main-20)",
            color: "var(--main-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--gray-1000)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 12,
                color: "var(--gray-500)",
                fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginTop: 2,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {/* Right side: action button or status dot */}
        <div style={{ flexShrink: 0 }}>
          {actionLabel && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                onAction?.();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 28,
                padding: "0 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                background: "var(--main-color)",
                color: "var(--gray-0)",
                cursor: "pointer",
                userSelect: "none",
                transition: "opacity 0.15s ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              {actionLabel}
            </span>
          )}
          {!actionLabel && statusLabel && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 12,
                color: "var(--gray-500)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: STATUS_COLORS[statusLevel] ?? STATUS_COLORS.info,
                }}
              />
              {statusLabel}
            </div>
          )}
        </div>
      </div>

      {/* Description (2-line clamp) */}
      {description && (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--gray-600)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {description}
        </div>
      )}

      {/* Tag row */}
      {tags && tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: "auto" }}>
          {tags.map((t, i) => (
            <Tag
              key={i}
              style={{
                margin: 0,
                borderRadius: 999,
                fontSize: 11,
                padding: "0 8px",
                lineHeight: "20px",
                ...(t.color
                  ? { color: t.color, borderColor: t.color, background: "transparent" }
                  : {}),
              }}
            >
              {t.label}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
}
