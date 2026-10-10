import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ShimmerText } from "./ShimmerText.js";

/**
 * The work-duration meta line at the TOP of an assistant turn.
 *
 *  - running: a pulsing accent dot + shimmering "生成中" + the elapsed seconds.
 *    This is the turn's only liveness indicator — it renders even before the
 *    first token arrives, so an empty turn is never silent.
 *  - done/error: a quiet "已工作 12s" (frozen at the persisted work_duration_ms,
 *    or the local elapsed fallback when the server value is unavailable).
 *
 * When `onToggle` is provided the row becomes the WHOLE turn's collapse switch:
 * a chevron signals expandability, and folded state appends failure/cancelled
 * counts so a stopped turn's outcome stays visible without expanding. While
 * running the row is never collapsible — the log must stay visible live.
 */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec % 60;
    return `${totalMin}m ${String(sec).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h ${String(min).padStart(2, "0")}m`;
}

export function WorkTimer({
  startedAtMs,
  durationMs,
  running,
  expanded,
  onToggle,
  failed = 0,
  cancelled = 0,
}: {
  startedAtMs?: number;
  durationMs?: number;
  running: boolean;
  /** When set (with onToggle), the row toggles the whole turn's process log. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Folded-state counters, surfaced next to the duration. */
  failed?: number;
  cancelled?: number;
}) {
  const [, forceTick] = useState(0);

  // Tick once per second while running so the label advances.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (running) {
    const elapsed = startedAtMs !== undefined ? formatDuration(Date.now() - startedAtMs) : undefined;
    return (
      // Same type + divider as the settled ("已工作") variant, so the timer row
      // reads as one consistent band across the whole turn lifecycle. Fixed
      // full-column width: the divider must not stretch as the seconds tick.
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        marginBottom: 8,
        paddingBottom: 8,
        borderBottom: "1px solid var(--border-subtle)",
      }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--accent-solid)",
            animation: "dotPulse 1.4s var(--ease) infinite",
            flexShrink: 0,
          }}
        />
        <ShimmerText text="工作中" fontSize={14} fontWeight={500} />
        {elapsed && (
          <>
            <span style={{ color: "var(--text-disabled)", fontSize: "var(--text-sm)" }}>·</span>
            <span className="tnum" style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>
              {elapsed}
            </span>
          </>
        )}
      </div>
    );
  }

  if (durationMs === undefined && !onToggle) return null;

  const counts: React.ReactNode[] = [];
  if (failed > 0) {
    counts.push(
      <span key="f" className="tnum" style={{ color: "var(--color-error-500)" }}>
        · {failed} 个失败
      </span>,
    );
  }
  if (cancelled > 0) {
    counts.push(
      <span key="c" className="tnum">
        · {cancelled} 个已取消
      </span>,
    );
  }

  // Collapsible switch (main timeline): the whole turn's process log folds
  // under this row.
  if (onToggle) {
    return (
      <button
        type="button"
        className="focus-ring"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          width: "100%",
          padding: 0,
          paddingBottom: 8,
          border: "none",
          borderBottom: "1px solid var(--border-subtle)",
          background: "transparent",
          cursor: "pointer",
          font: "inherit",
          // Same type as the 「已执行工具」 block summaries below.
          fontSize: "var(--text-sm)",
          marginBottom: 8,
        }}
      >
        <span style={{ display: "flex", fontSize: 14, color: "var(--text-disabled)", flexShrink: 0 }}>
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </span>
        <span className="tnum" style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
          已工作 {formatDuration(durationMs ?? 0)}
        </span>
        {counts}
      </button>
    );
  }

  // Plain display row (no toggle wired — fallback paths).
  return (
    <div style={{ display: "flex", alignItems: "center", height: 22, marginBottom: 2 }}>
      <span className="tnum" style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
        已工作 {formatDuration(durationMs ?? 0)}
      </span>
    </div>
  );
}