// =============================================================================
// Terminal capability detection.
// Equivalent to Python tui.terminal_capabilities.
// =============================================================================

import { env } from "node:process";

// =============================================================================
// Kitty keyboard protocol
// =============================================================================

let _supportsKitty: boolean | null = null;

/**
 * Detect whether the terminal supports the Kitty keyboard protocol.
 * This enables enhanced key events (distinct key-up/key-down, modifiers).
 */
export function supportsKittyKeyboardProtocol(): boolean {
  if (_supportsKitty !== null) return _supportsKitty;

  // Check explicit override
  if (env.DEEPAGENTS_CODE_KITTY_KEYBOARD?.toLowerCase() === "true") {
    _supportsKitty = true;
    return true;
  }
  if (env.DEEPAGENTS_CODE_KITTY_KEYBOARD?.toLowerCase() === "false") {
    _supportsKitty = false;
    return false;
  }

  // Check for kitty terminal indicators
  if (env.KITTY_WINDOW_ID) {
    _supportsKitty = true;
    return true;
  }

  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("kitty") || term.includes("ghostty")) {
    _supportsKitty = true;
    return true;
  }

  _supportsKitty = false;
  return false;
}

// =============================================================================
// Terminal size
// =============================================================================

/**
 * Get the terminal size (columns, rows).
 */
export function getTerminalSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

// =============================================================================
// Color support
// =============================================================================

/**
 * Detect the level of color support in the terminal.
 * Uses the COLORTERM env var and NO_COLOR convention.
 */
export function detectColorLevel(): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR) return 0;

  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return 3; // True color

  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("256color")) return 2; // 256 colors
  if (term.includes("color")) return 1; // 16 colors

  // Windows Terminal and VSCode support true color
  if (env.WT_SESSION || env.VSCODE_PID) return 3;

  return 0;
}
