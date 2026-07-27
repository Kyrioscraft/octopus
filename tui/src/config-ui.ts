// =============================================================================
// TUI display configuration — glyphs, ASCII/Unicode mode, terminal charset
// detection. Equivalent to Python tui.config_ui.
// =============================================================================

import { env } from "node:process";

// =============================================================================
// Glyphs — Unicode and ASCII fallback sets
// =============================================================================

export interface Glyphs {
  /** Ellipsis for truncated text. */
  ellipsis: string;
  /** Checkmark for completed items. */
  checkmark: string;
  /** Cross mark for errors or rejection. */
  cross: string;
  /** Right-pointing arrow. */
  arrow: string;
  /** Bullet point. */
  bullet: string;
  /** Horizontal line/rule. */
  hrule: string;
  /** Tool prefix indicator. */
  toolPrefix: string;
  /** Spinner frames (array of animation frames). */
  spinnerFrames: string[];
  /** Box-drawing: top-left corner. */
  boxTopLeft: string;
  /** Box-drawing: top-right corner. */
  boxTopRight: string;
  /** Box-drawing: bottom-left corner. */
  boxBottomLeft: string;
  /** Box-drawing: bottom-right corner. */
  boxBottomRight: string;
  /** Box-drawing: horizontal line. */
  boxHorizontal: string;
  /** Box-drawing: vertical line. */
  boxVertical: string;
  /** Box-drawing: T-junction down. */
  boxTDown: string;
  /** Box-drawing: T-junction up. */
  boxTUp: string;
  /** Box-drawing: T-junction right. */
  boxTRight: string;
  /** Box-drawing: T-junction left. */
  boxTLeft: string;
  /** Box-drawing: cross. */
  boxCross: string;
  /** Scrollbar: arrow pointing up. */
  scrollUp: string;
  /** Scrollbar: arrow pointing down. */
  scrollDown: string;
  /** Scrollbar: empty track (light shade / dots). */
  scrollTrack: string;
  /** Scrollbar: thumb indicator (full block / hash). */
  scrollThumb: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  ellipsis: "…",
  checkmark: "✓",
  cross: "✗",
  arrow: "→",
  bullet: "•",
  hrule: "─".repeat(40),
  toolPrefix: "⚙",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  boxTopLeft: "┌",
  boxTopRight: "┐",
  boxBottomLeft: "└",
  boxBottomRight: "┘",
  boxHorizontal: "─",
  boxVertical: "│",
  boxTDown: "┬",
  boxTUp: "┴",
  boxTRight: "├",
  boxTLeft: "┤",
  boxCross: "┼",
  scrollUp: "▲",
  scrollDown: "▼",
  scrollTrack: "░",
  scrollThumb: "█",
};

export const ASCII_GLYPHS: Glyphs = {
  ellipsis: "...",
  checkmark: "+",
  cross: "x",
  arrow: "->",
  bullet: "*",
  hrule: "-".repeat(40),
  toolPrefix: "[tool]",
  spinnerFrames: ["|", "/", "-", "\\"],
  boxTopLeft: "+",
  boxTopRight: "+",
  boxBottomLeft: "+",
  boxBottomRight: "+",
  boxHorizontal: "-",
  boxVertical: "|",
  boxTDown: "+",
  boxTUp: "+",
  boxTRight: "+",
  boxTLeft: "+",
  boxCross: "+",
  scrollUp: "^",
  scrollDown: "v",
  scrollTrack: ".",
  scrollThumb: "#",
};

// =============================================================================
// Charset detection
// =============================================================================

let _asciiMode: boolean | null = null;

/**
 * Detect whether the terminal supports Unicode or should fall back to ASCII.
 * Cached after first call.
 *
 * Equivalent to Python `is_ascii_mode()`.
 */
export function isAsciiMode(): boolean {
  if (_asciiMode !== null) return _asciiMode;

  // Check explicit override
  if (env.DEEPAGENTS_CODE_ASCII_MODE?.toLowerCase() === "true") {
    _asciiMode = true;
    return true;
  }

  // Check terminal type
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb" || term === "linux") {
    _asciiMode = true;
    return true;
  }

  // Check for known Unicode-capable terminals
  if (env.WT_SESSION || env.VSCODE_PID || env.TERM_PROGRAM === "vscode") {
    _asciiMode = false;
    return false;
  }

  // Default: assume Unicode-capable
  _asciiMode = false;
  return false;
}

/**
 * Get the glyph set appropriate for the current terminal.
 * Cached after first call.
 */
let _glyphsCache: Glyphs | null = null;

export function getGlyphs(): Glyphs {
  if (_glyphsCache) return _glyphsCache;
  _glyphsCache = isAsciiMode() ? ASCII_GLYPHS : UNICODE_GLYPHS;
  return _glyphsCache;
}

/**
 * Clear cached glyph/charset detection (for testing or after terminal change).
 */
export function clearGlyphCache(): void {
  _asciiMode = null;
  _glyphsCache = null;
}

// =============================================================================
// Mode display helpers
// =============================================================================

/** Prefixes that switch input mode (typed at the start of an empty line). */
export const MODE_PREFIXES: Record<string, string> = {
  "!": "shell",
  "!!": "shell_incognito",
  "/": "command",
};

/** Display glyphs for each mode (shown in the input prompt). */
export const MODE_DISPLAY_GLYPHS: Record<string, string> = {
  normal: "",
  shell: "!",
  shell_incognito: "!!",
  command: "/",
};

/**
 * Detect the input mode from the current text.
 * Returns the mode name and the text with the prefix stripped.
 */
export function detectModePrefix(text: string): [string, string] {
  for (const [prefix, mode] of Object.entries(MODE_PREFIXES)) {
    if (text.startsWith(prefix) && text.length === prefix.length) {
      return [mode, ""];
    }
  }
  return ["normal", text];
}

// =============================================================================
// Banner
// =============================================================================

export const UNICODE_BANNER = `
  ╔══════════════════════════════════════╗
  ║           Octopus AI Agent           ║
  ╚══════════════════════════════════════╝
`;

export const ASCII_BANNER = `
  +======================================+
  |           Octopus AI Agent           |
  +======================================+
`;

export function getBanner(): string {
  return isAsciiMode() ? ASCII_BANNER : UNICODE_BANNER;
}
