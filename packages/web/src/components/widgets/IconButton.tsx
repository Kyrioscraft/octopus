import type { MouseEventHandler, ReactNode } from "react";
import { Tooltip } from "antd";

/**
 * The app's one square icon button (header actions, sidebar footer, composer
 * actions). Replaces the previous mix of antd `<Button type="text">` with inline
 * size/radius overrides and hand-written `onMouseEnter` colour swaps: styling and
 * hover now come from the `.icon-btn` class, so focus-visible works too.
 *
 * Renders an `<a>` when `href` is given, otherwise a `<button>`.
 */
export function IconButton({
  icon,
  title,
  active = false,
  size = 32,
  iconSize = 16,
  onClick,
  href,
  target,
}: {
  icon: ReactNode;
  /** Tooltip + accessible name. */
  title: string;
  /** Renders in the accent "on" state (e.g. the companion panel is open). */
  active?: boolean;
  size?: number;
  iconSize?: number;
  onClick?: MouseEventHandler;
  href?: string;
  target?: string;
}) {
  const className = `icon-btn focus-ring${active ? " is-active" : ""}`;
  const style = { width: size, height: size };
  const inner = (
    <span style={{ display: "flex", alignItems: "center", fontSize: iconSize, lineHeight: 1 }}>
      {icon}
    </span>
  );

  return (
    <Tooltip title={title}>
      {href ? (
        <a
          className={className}
          style={style}
          href={href}
          target={target}
          rel={target === "_blank" ? "noopener noreferrer" : undefined}
          aria-label={title}
        >
          {inner}
        </a>
      ) : (
        <button className={className} style={style} onClick={onClick} aria-label={title}>
          {inner}
        </button>
      )}
    </Tooltip>
  );
}