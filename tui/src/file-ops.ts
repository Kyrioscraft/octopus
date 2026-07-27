// =============================================================================
// File operation tracker — tracks file reads/writes/edits with metrics.
// Equivalent to Python tui.file_ops.
// =============================================================================

import { createPatch } from "diff";

// =============================================================================
// Types
// =============================================================================

export interface FileOpMetrics {
  linesRead: number;
  linesWritten: number;
  linesAdded: number;
  linesRemoved: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface FileOperationRecord {
  toolName: string;
  filePath: string;
  before?: string;
  after?: string;
  metrics: FileOpMetrics;
  hitlApproved: boolean;
}

// =============================================================================
// FileOpTracker
// =============================================================================

export class FileOpTracker {
  #operations: FileOperationRecord[] = [];

  /** Start tracking a new file operation. */
  startOperation(toolName: string, filePath: string): void {
    this.#operations.push({
      toolName,
      filePath,
      metrics: {
        linesRead: 0,
        linesWritten: 0,
        linesAdded: 0,
        linesRemoved: 0,
        bytesRead: 0,
        bytesWritten: 0,
      },
      hitlApproved: false,
    });
  }

  /** Record that the operation was HITL-approved. */
  markHitlApproved(filePath: string): void {
    const op = this.#getLatest(filePath);
    if (op) op.hitlApproved = true;
  }

  /** Complete a read operation. */
  completeRead(filePath: string, content: string): void {
    const op = this.#getLatest(filePath);
    if (op) {
      op.metrics.bytesRead = content.length;
      op.metrics.linesRead = content.split("\n").length;
    }
  }

  /** Complete a write operation. */
  completeWrite(filePath: string, content: string, before?: string): void {
    const op = this.#getLatest(filePath);
    if (op) {
      op.after = content;
      op.before = before;
      op.metrics.bytesWritten = content.length;
      op.metrics.linesWritten = content.split("\n").length;

      if (before) {
        op.metrics.linesAdded = Math.max(0, content.split("\n").length - before.split("\n").length);
        op.metrics.linesRemoved = Math.max(0, before.split("\n").length - content.split("\n").length);
      }
    }
  }

  /** Get all recorded operations. */
  getOperations(): readonly FileOperationRecord[] {
    return this.#operations;
  }

  /** Clear tracked operations. */
  clear(): void {
    this.#operations = [];
  }

  /** Get the latest operation for a file path. */
  #getLatest(filePath: string): FileOperationRecord | undefined {
    for (let i = this.#operations.length - 1; i >= 0; i--) {
      if (this.#operations[i].filePath === filePath) {
        return this.#operations[i];
      }
    }
    return undefined;
  }
}

// =============================================================================
// Unified diff computing
// =============================================================================

/**
 * Compute a unified diff between two strings.
 * Equivalent to Python `compute_unified_diff()`.
 */
export function computeUnifiedDiff(
  before: string,
  after: string,
  displayPath: string,
): string | null {
  if (before === after) return null;

  const patch = createPatch(displayPath, before, after, "before", "after");
  if (!patch) return null;

  // Truncate to 200 lines max
  const lines = patch.split("\n");
  if (lines.length > 200) {
    return lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`;
  }

  return patch;
}

// =============================================================================
// Display path formatting
// =============================================================================

/**
 * Format a path for display — replace home directory with ~.
 */
export function formatDisplayPath(path: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}
