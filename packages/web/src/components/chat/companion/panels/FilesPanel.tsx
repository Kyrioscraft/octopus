import { WorkspaceFileTree } from "../../../workspace/WorkspaceFileTree.js";
import type { CompanionPanelProps } from "../types.js";

/**
 * Files panel — workspace file browser.
 *
 * A thin wrapper around the self-contained `WorkspaceFileTree` (which manages
 * its own tree fetching, selection, and preview). The wrapper exists so the
 * companion container treats every panel uniformly (a single component to render
 * per tab kind). `WorkspaceFileTree` reads the active workspace from the store
 * internally, so no props are needed here.
 */
export function FilesPanel(_props: CompanionPanelProps) {
  return <WorkspaceFileTree />;
}
