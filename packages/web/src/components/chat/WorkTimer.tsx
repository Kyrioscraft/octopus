import { useState, useEffect } from "react";
import { ShimmerText } from "./ShimmerText.js";

/**
 * The work-duration meta line at the TOP of an assistant turn.
 *
 *  - running: a pulsing accent dot + shimmering "生成中" + the elapsed seconds.
 *    This is the turn's only liveness indicator — it renders even before the
 *    first token arrives, so an empty turn is never silent.
 *  - done/error: a quiet "已工作 12s" (frozen at the persisted work_duration_ms,
 *    or the local elapsed fallback when the server value is unavailable).
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
}: {
  startedAtMs?: number;
  durationMs?: number;
  running: boolean;
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
      <div style={{ display: "flex", alignItems: "center", gap: 7, height: 22, marginBottom: 2 }}>
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
        <ShimmerText text="生成中" fontSize={12.5} fontWeight={500} />
        {elapsed && (
          <>
            <span style={{ color: "var(--text-disabled)", fontSize: 12.5 }}>·</span>
            <span className="tnum" style={{ fontSize: 12.5, color: "var(--text-tertiary)" }}>
              {elapsed}
            </span>
          </>
        )}
      </div>
    );
  }

  if (durationMs === undefined) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", height: 22, marginBottom: 2 }}>
      <span className="tnum" style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
        已工作 {formatDuration(durationMs)}
      </span>
    </div>
  );
}