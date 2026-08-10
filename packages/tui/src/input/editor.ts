// =============================================================================
// External editor integration — open current input in $EDITOR / $VISUAL.
// Equivalent to Python tui.editor.
// =============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";

// =============================================================================
// Editor resolution
// =============================================================================

/**
 * Resolve the external editor command.
 * Reads $VISUAL → $EDITOR → platform fallback.
 *
 * Equivalent to Python `resolve_editor()`.
 */
export function resolveEditor(): string[] | null {
  const visual = process.env.VISUAL;
  if (visual) return visual.split(/\s+/);

  const editor = process.env.EDITOR;
  if (editor) return editor.split(/\s+/);

  // Platform fallbacks
  if (platform() === "win32") return ["notepad"];
  return ["vi"];
}

// =============================================================================
// Open in editor
// =============================================================================

/**
 * Open the given text in an external editor and return the edited content.
 * Returns `null` if the user cancelled or an error occurred.
 *
 * Equivalent to Python `open_in_editor()`.
 */
export function openInEditor(currentText: string): string | null {
  const editorCmd = resolveEditor();
  if (!editorCmd) return null;

  // Create temp file
  const tmpPath = join(tmpdir(), `octopus-input-${Date.now()}.md`);
  try {
    writeFileSync(tmpPath, currentText, "utf-8");

    // Spawn editor with wait flags
    const args = buildEditorArgs(editorCmd[0]);
    const result = spawnSync(editorCmd[0], [...args, tmpPath], {
      stdio: "inherit",
      timeout: 300_000, // 5 min timeout
    });

    if (result.error) {
      return null;
    }

    // Read back content
    const edited = readFileSync(tmpPath, "utf-8");

    // Normalize line endings
    return edited.replace(/\r\n/g, "\n").trim();
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build platform-appropriate wait flags for the editor.
 */
function buildEditorArgs(editorName: string): string[] {
  const name = editorName.toLowerCase();

  // vim/neovim: -i NONE to avoid swap files
  if (name.includes("vim") || name.includes("nvim")) {
    return ["-i", "NONE"];
  }

  // VS Code / Cursor / Windsurf: --wait
  if (
    name.includes("code") ||
    name.includes("cursor") ||
    name.includes("windsurf")
  ) {
    return ["--wait"];
  }

  // GUI editors on macOS: -W (wait) flag
  // Handled by spawnSync's synchronous behavior

  return [];
}
