/**
 * Shimmer (wave-flash) text — the animated gradient label effect.
 *
 * Used for in-flight labels (e.g. a running tool row's display name) so the
 * user can see at a glance which item is still executing. Base and wave colours
 * come from the text scale, so the effect reads on both light and dark surfaces.
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
          "linear-gradient(90deg, var(--text-secondary) 0%, var(--text-secondary) 40%, var(--text-disabled) 45%, var(--text-disabled) 50%, var(--text-disabled) 55%, var(--text-secondary) 60%, var(--text-secondary) 100%)",
        backgroundSize: "200% auto",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        animation: "waveFlash 2s linear infinite",
        fontSize,
        fontWeight,
      }}
    >
      {text}
    </span>
  );
}