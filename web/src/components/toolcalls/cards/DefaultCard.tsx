import type { ToolCardProps } from "../types.js";
import { ToolCallCard } from "../ToolCallCard.js";

/**
 * Fallback card for tools without a dedicated renderer. Just shows the
 * args JSON + result text via the default ToolCallCard body.
 */
export function DefaultCard({ entry }: ToolCardProps) {
  return <ToolCallCard entry={entry} />;
}
