import type { ToolCardProps } from "../types.js";
import { ToolCallCard } from "../ToolCallCard.js";
import { getToolDisplayName, truncate } from "../registry.js";
import { Markdown } from "../../Markdown.js";

/**
 * Subagent (task tool) card — flat design (à la yuxi). Shows the subagent
 * type + description in the header; the body is the subagent's final result
 * text rendered as markdown. We deliberately do NOT recurse into the
 * subagent's internal steps.
 */
export function TaskCard({ entry }: ToolCardProps) {
  const args = entry.args as {
    subagent_type?: string;
    description?: string;
  };
  const subagentType = args.subagent_type ?? "general-purpose";
  const description = args.description ?? "";

  return (
    <ToolCallCard
      entry={entry}
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ color: "var(--gray-700)" }}>{getToolDisplayName(entry.name)}</span>
          <span style={{ color: "var(--gray-300)" }}>|</span>
          <span style={{ color: "var(--gray-900)", fontWeight: 600 }}>{subagentType}</span>
          {description && (
            <>
              <span style={{ color: "var(--gray-300)" }}>|</span>
              <span
                title={description}
                style={{ color: "var(--gray-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {truncate(description, 60)}
              </span>
            </>
          )}
        </span>
      }
      body={
        entry.result ? (
          <div style={{ paddingTop: 4 }}>
            <Markdown content={entry.result} />
          </div>
        ) : (
          <div style={{ paddingTop: 6, color: "var(--gray-500)", fontSize: 13, fontStyle: "italic" }}>
            子智能体执行中…
          </div>
        )
      }
    />
  );
}
