import { useState, useEffect } from "react";

/**
 * zcode-style work-duration label ("已工作 12s" / "已工作 1m 05s" / "已工作 1h 02m").
 *
 * Shown at the TOP of an assistant turn for its whole lifetime:
 *  - running: ticks every second from `startedAtMs`, with a spinning loader.
 *  - done/error: frozen at `durationMs` (persisted work_duration_ms, or the
 *    local elapsed fallback when the server value is unavailable).
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
    if (startedAtMs === undefined) return null;
    return (
      <div style={{ padding: "2px 0 6px 6px" }}>
        <span style={{ fontSize: 12, color: "var(--gray-500)", letterSpacing: "0.025em" }}>
          已工作 {formatDuration(Date.now() - startedAtMs)}
        </span>
      </div>
    );
  }

  if (durationMs === undefined) return null;
  return (
    <div style={{ padding: "2px 0 6px 6px" }}>
      <span style={{ fontSize: 12, color: "var(--gray-400)", letterSpacing: "0.025em" }}>
        已工作 {formatDuration(durationMs)}
      </span>
    </div>
  );
}
