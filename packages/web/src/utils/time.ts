import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import relativeTime from "dayjs/plugin/relativeTime";

// Enable "x 分钟前" style output and Chinese phrasing.
dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

/**
 * Format an ISO timestamp as a Chinese relative time string, e.g. "3 小时前".
 * Uses dayjs's relativeTime plugin thresholds so it degrades naturally
 * (几秒前 → N 分钟前 → N 小时前 → N 天前 → N 个月前 → N 年前).
 *
 * Returns "—" for falsy/unparseable input so callers can render safely.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = dayjs(iso);
  if (!d.isValid()) return "—";
  return d.fromNow();
}
