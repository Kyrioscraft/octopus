// =============================================================================
// Terminal escape sequences — OSC 9;4 progress bars, OSC 11 background.
// Equivalent to Python tui.terminal_escape.
//
// All functions are best-effort: they fire and forget, never throw.
// =============================================================================

// =============================================================================
// OSC escape sequence writer
// =============================================================================

/**
 * Write an OSC (Operating System Command) escape sequence to the terminal.
 * Prefers /dev/tty on Unix; falls back to stderr.
 *
 * Equivalent to Python `write_terminal_escape()`.
 */
function writeOsc(command: string, payload: string): void {
  const sequence = `\x1b]${command};${payload}\x07`;
  try {
    process.stderr.write(sequence);
  } catch {
    /* silently ignore */
  }
}

// =============================================================================
// Taskbar progress (OSC 9;4)
// =============================================================================
// See: https://conemu.github.io/en/AnsiEscapeCodes.html#ConEmu_specific_OSC

export function setTerminalProgress(
  progress: number,
  state: "normal" | "error" | "warning" | "indeterminate" | "clear" = "normal",
): void {
  // Progress: 0-100 for normal/error/warning, 0 for clear
  const stateMap: Record<string, number> = {
    normal: 1,
    error: 2,
    warning: 3,
    indeterminate: 0,
    clear: 0,
  };
  const stateCode = stateMap[state] ?? 1;
  const payload = `${stateCode};${Math.round(progress)}`;
  writeOsc("9;4", payload);
}

/**
 * Clear the taskbar progress indicator.
 */
export function clearTerminalProgress(): void {
  setTerminalProgress(0, "clear");
}

// =============================================================================
// Terminal background (OSC 11)
// =============================================================================

/**
 * Set the terminal background color temporarily.
 * Use `resetTerminalBackground()` to restore.
 *
 * @param color - Hex color (e.g., "#1a1b26") or named color.
 */
export function setTerminalBackground(color: string): void {
  writeOsc("11", color);
}

/**
 * Reset the terminal background to default.
 */
export function resetTerminalBackground(): void {
  writeOsc("111", "");
}
