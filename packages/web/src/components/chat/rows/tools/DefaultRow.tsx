import type { ToolCardProps } from "./types.js";
import { ToolCallRow } from "./ToolCallRow.js";

/**
 * Fallback row for tools without a dedicated renderer. Just shows the
 * args JSON + result text via the default ToolCallRow body.
 */
export function DefaultRow({ entry, defaultExpanded }: ToolCardProps) {
  return <ToolCallRow entry={entry} />;
}
