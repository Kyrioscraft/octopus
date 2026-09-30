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

/** The buckets the conversation list is grouped into, in display order. */
export type DayGroup = "今天" | "昨天" | "过去 7 天" | "更早";

const DAY_GROUPS: DayGroup[] = ["今天", "昨天", "过去 7 天", "更早"];

/**
 * Bucket a timestamp into one of the conversation-list groups. Day boundaries are
 * calendar-based (not "N * 24h ago") so an item created at 23:59 is "昨天" rather
 * than "今天" the next morning.
 */
export function dayGroupOf(iso: string | null | undefined): DayGroup {
  const d = dayjs(iso);
  if (!iso || !d.isValid()) return "更早";
  const now = dayjs();
  const startOfToday = now.startOf("day");
  if (!d.isBefore(startOfToday)) return "今天";
  if (!d.isBefore(startOfToday.subtract(1, "day"))) return "昨天";
  if (!d.isBefore(startOfToday.subtract(6, "day"))) return "过去 7 天";
  return "更早";
}

/** Group items by `dayGroupOf`, dropping empty buckets and keeping group order. */
export function groupByDay<T>(
  items: T[],
  getIso: (item: T) => string | null | undefined,
): { group: DayGroup; items: T[] }[] {
  const buckets = new Map<DayGroup, T[]>();
  for (const item of items) {
    const group = dayGroupOf(getIso(item));
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }
  return DAY_GROUPS.filter((g) => buckets.has(g)).map((g) => ({
    group: g,
    items: buckets.get(g)!,
  }));
}
