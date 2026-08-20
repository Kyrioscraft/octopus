import { useMemo, useState } from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { Segmented } from "antd";
import type { ToolCardProps } from "./types.js";
import { ToolCallRow, DiffStat } from "./ToolCallRow.js";
import { basename, countLines, inferLanguage } from "./registry.js";
import { useThemeStore } from "../../../../stores/theme.js";
import { ShimmerText } from "../../ShimmerText.js";

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
export function FileEditRow({ entry, defaultExpanded }: ToolCardProps) {
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
      diffViewerBackground: "var(--gray-0)",
      diffViewerTitleBackground: "var(--gray-25)",
      diffViewerTitleColor: "var(--gray-700)",
      diffViewerTitleBorderColor: "var(--gray-150)",
      diffViewerColor: "var(--gray-900)",
      addedBackground: "rgba(82, 196, 26, 0.10)",
      addedColor: "var(--gray-900)",
      addedGutterBackground: "rgba(82, 196, 26, 0.18)",
      addedGutterColor: "var(--color-success-700)",
      removedBackground: "rgba(255, 77, 79, 0.10)",
      removedColor: "var(--gray-900)",
      removedGutterBackground: "rgba(255, 77, 79, 0.18)",
      removedGutterColor: "var(--color-error-700)",
      wordAddedBackground: "rgba(82, 196, 26, 0.25)",
      wordRemovedBackground: "rgba(255, 77, 79, 0.25)",
      gutterBackground: "var(--gray-25)",
      gutterBackgroundDark: "var(--gray-50)",
      gutterColor: "var(--gray-400)",
      codeFoldGutterBackground: "var(--gray-25)",
      codeFoldBackground: "var(--gray-25)",
      codeFoldContentColor: "var(--gray-500)",
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
defaultExpanded={defaultExpanded}
      header={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {running ? <ShimmerText text="编辑" /> : <span style={{ color: "var(--gray-500)" }}>编辑</span>}
          <span style={{ color: "var(--gray-400)" }}>|</span>
          <code
            title={filePath}
            style={{
              fontSize: 12,
              background: "var(--gray-100)",
              padding: "1px 6px",
              borderRadius: 4,
              color: "var(--gray-900)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fileName || "(unknown)"}
          </code>
          <DiffStat added={added} removed={removed} />
        </span>
      }
      body={
        <div style={{ paddingTop: 4 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginBottom: 6,
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
              border: "1px solid var(--gray-150)",
              borderRadius: 6,
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
                  fontFamily:
                    "SFMono-Regular, Consolas, Menlo, monospace",
                  lineHeight: "1.55",
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
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--color-success-700)",
                background: "var(--color-success-50)",
                borderRadius: 6,
                border: "1px solid var(--color-success-100)",
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
