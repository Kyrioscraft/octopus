// =============================================================================
// Cross-platform clipboard support.
// Equivalent to Python tui.clipboard.
//
// Uses a tiered fallback strategy: native command → OSC 52 escape.
// =============================================================================

import { execSync } from "node:child_process";
import { platform } from "node:os";
import { getGlyphs } from "./config-ui.js";

// =============================================================================
// Copy to clipboard
// =============================================================================

export interface ClipboardResult {
  success: boolean;
  error?: string;
}

/**
 * Copy text to the system clipboard.
 * Tries platform-specific commands first, then OSC 52 terminal escape.
 *
 * Equivalent to Python `copy_text_to_clipboard()`.
 */
export function copyToClipboard(text: string): ClipboardResult {
  // Try platform-specific commands
  try {
    const sys = platform();
    if (sys === "win32") {
      execSync("clip", { input: text, timeout: 5000 });
      return { success: true };
    }
    if (sys === "darwin") {
      execSync("pbcopy", { input: text, timeout: 5000 });
      return { success: true };
    }
    // Linux — try wl-copy (Wayland) then xclip (X11)
    try {
      execSync("wl-copy", { input: text, timeout: 3000 });
      return { success: true };
    } catch {
      execSync("xclip -selection clipboard", { input: text, timeout: 3000 });
      return { success: true };
    }
  } catch (err) {
    // Fall through to OSC 52
  }

  // OSC 52 fallback (works in most modern terminals)
  try {
    const osc52 = buildOsc52(text);
    process.stdout.write(osc52);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// =============================================================================
// OSC 52 escape sequence
// =============================================================================

/**
 * Build an OSC 52 clipboard escape sequence.
 * See: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (OSC 52)
 */
function buildOsc52(text: string): string {
  const base64 = Buffer.from(text).toString("base64");
  return `\x1b]52;c;${base64}\x07`;
}

// =============================================================================
// Convenience: copy with toast notification
// =============================================================================

/**
 * Copy text and return a user-facing message.
 */
export function copyTextWithMessage(text: string): string {
  const glyphs = getGlyphs();
  const result = copyToClipboard(text);
  if (result.success) {
    return `${glyphs.checkmark} Copied to clipboard (${text.length} chars)`;
  }
  return `${glyphs.cross} Failed to copy: ${result.error}`;
}
