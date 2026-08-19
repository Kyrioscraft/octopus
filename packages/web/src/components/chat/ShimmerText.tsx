/**
 * Shimmer (wave-flash) text — the animated gradient label effect.
 *
 * Used for in-flight labels (e.g. a running tool row's display name) so the
 * user can see at a glance which item is still executing. The same visual as
 * the former "正在生成回复..." placeholder, extracted for reuse.
 */
export function ShimmerText({
  text,
  fontSize = 12,
  fontWeight = 500,
}: {
  text: string;
  fontSize?: number;
  fontWeight?: number;
}) {
  return (
    <span
      style={{
        background:
          "linear-gradient(90deg, var(--gray-700) 0%, var(--gray-700) 40%, var(--gray-300) 45%, var(--gray-200) 50%, var(--gray-300) 55%, var(--gray-700) 60%, var(--gray-700) 100%)",
        backgroundSize: "200% auto",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        animation: "waveFlash 2s linear infinite",
        fontSize,
        fontWeight,
        letterSpacing: "0.025em",
      }}
    >
      {text}
    </span>
  );
}
