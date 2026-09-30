import { useMemo, useState } from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { Segmented } from "antd";
import type { ToolCardProps } from "./types.js";
import { ToolCallRow, DiffStat, ToolRowHeader } from "./ToolCallRow.js";
import { basename, countLines, inferLanguage } from "./registry.js";
import { useThemeStore } from "../../../../stores/theme.js";

/**
 * edit_file / replace row — the headline feature. Renders a real unified /
 * split diff between old_string and new_string using react-diff-viewer-continued.
 *
 * The diff is computed purely on the client from the tool-call arguments
 * (which are persisted in the messages.tool_calls JSON column), so history
 * reloads show the same diff with no server changes. This mirrors the
 * industry-standard approach (Cline / Roo / Cursor all recompute from
 * old/new strings rather than storing a rendered diff).
 *
 * `showDiffOnly` collapses unchanged context lines (±3 by default), keeping
 * large edits readable. The viewer memoises the diff internally, so repeated
 * renders during a live stream are cheap.
 */
export function FileEditRow({ entry }: ToolCardProps) {
  const args = entry.args as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
  };
  const filePath = args.file_path ?? "";
  const fileName = basename(filePath);
  const oldStr = args.old_string ?? "";
  const newStr = args.new_string ?? "";
  const language = useMemo(() => inferLanguage(filePath), [filePath]);
  // Diff viewer follows the app theme. All variable values are CSS vars, so
  // the same map works for both surfaces — we just hand a copy to `dark` so
  // react-diff-viewer-continued reads it when useDarkTheme is true.
  const isDark = useThemeStore((s) => s.resolved) === "dark";
  const diffVariables = useMemo(() => {
    const surface = {
      diffViewerBackground: "var(--bg-elevated)",
      diffViewerTitleBackground: "var(--bg-subtle)",
      diffViewerTitleColor: "var(--text-secondary)",
      diffViewerTitleBorderColor: "var(--border-default)",
      diffViewerColor: "var(--text-primary)",
      addedBackground: "rgba(18, 183, 106, 0.10)",
      addedColor: "var(--text-primary)",
      addedGutterBackground: "rgba(18, 183, 106, 0.18)",
      addedGutterColor: "var(--color-success-700)",
      removedBackground: "rgba(217, 45, 32, 0.10)",
      removedColor: "var(--text-primary)",
      removedGutterBackground: "rgba(217, 45, 32, 0.18)",
      removedGutterColor: "var(--color-error-700)",
      wordAddedBackground: "rgba(18, 183, 106, 0.25)",
      wordRemovedBackground: "rgba(217, 45, 32, 0.25)",
      gutterBackground: "var(--bg-subtle)",
      gutterBackgroundDark: "var(--bg-muted)",
      gutterColor: "var(--text-disabled)",
      codeFoldGutterBackground: "var(--bg-subtle)",
      codeFoldBackground: "var(--bg-subtle)",
      codeFoldContentColor: "var(--text-tertiary)",
    };
    return { light: surface, dark: surface };
  }, []);
  const added = countLines(newStr);
  const removed = countLines(oldStr);

  // View mode toggle: unified (inline) vs split (side-by-side).
  const [view, setView] = useState<"unified" | "split">("unified");

  // Heuristic: if either side is very long, default to diff-only collapsed
  // view (already the viewer default) and bump surrounding context down.
  const isLarge = added + removed > 200;
  const running = entry.status === "running" || entry.status === "pending";

  return (
    <ToolCallRow
      entry={entry}
      header={
        <ToolRowHeader
          verb="编辑"
          running={running}
          detail={fileName || "(unknown)"}
          detailTitle={filePath}
          tail={<DiffStat added={added} removed={removed} />}
        />
      }
      body={
        <div style={{ paddingTop: 4 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginBottom: 8,
            }}
          >
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as "unified" | "split")}
              options={[
                { label: "合并", value: "unified" },
                { label: "分栏", value: "split" },
              ]}
            />
          </div>
          <div
            style={{
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              overflow: "hidden",
            }}
          >
            <ReactDiffViewer
              oldValue={oldStr}
              newValue={newStr}
              splitView={view === "split"}
              showDiffOnly
              extraLinesSurroundingDiff={isLarge ? 2 : 3}
              hideLineNumbers={false}
              compareMethod={DiffMethod.WORDS}
              useDarkTheme={isDark}
              highlightLanguage={language}
              hideSummary
              disableWorker
              styles={{
                variables: diffVariables,
                contentText: {
                  fontSize: "12px",
                  fontFamily: "var(--font-mono)",
                  lineHeight: "1.6",
                },
                gutter: {
                  fontSize: "11px",
                  padding: "0 6px",
                },
              }}
            />
          </div>
          {entry.result && (
            <div
              style={{
                marginTop: 8,
                padding: "7px 10px",
                fontSize: 12,
                color: "var(--color-success-700)",
                background: "var(--color-success-50)",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-success-100)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ✓ {entry.result}
            </div>
          )}
        </div>
      }
    />
  );
}
