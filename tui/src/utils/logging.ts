/**
 * TUI debug logging — file-based, behind a configuration switch.
 *
 * The core logger (`@octopus/core` logging.ts) writes to a single
 * `NodeJS.WritableStream` (default `process.stderr`). In interactive Ink
 * mode, writing to stderr corrupts the terminal render, so the TUI cannot
 * use that default. Instead, this module:
 *
 *   1. Creates a write stream that appends to `~/.deepagents/logs/tui.log`
 *   2. Passes it to core's `configure({ stream, level, colors: false })`
 *   3. Exposes a `getLogger(name)` that returns the same cached Logger the
 *      core factory produces — no parallel logging implementation.
 *
 * Activation (any one):
 *   - `--debug` CLI flag (stackable: `--debug --debug` → verbose)
 *   - `OCTOPUS_TUI_DEBUG=1` env var (also accepts "true", "yes", "on")
 *   - `OCTOPUS_TUI_DEBUG=2` → verbose/trace level
 *
 * When disabled (default), `configure()` is still called with level=WARN so
 * that `logger.debug(...)` calls scattered through the source are no-ops
 * with zero runtime cost. This lets us instrument the code without gating
 * every call behind `if (debug)`.
 *
 * Stack traces: use `logger.exception(msg, err)` — core formats the full
 * `err.stack` indented on the line below the message. This replaces the
 * pervasive `(err as Error).message` pattern that was silently discarding
 * stacks throughout the TUI.
 */

import {
  mkdirSync,
  appendFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  configure,
  getLogger as coreGetLogger,
  LogLevel,
} from "@octopus/core";
import type { Logger } from "@octopus/core";

// =============================================================================
// Log file path
// =============================================================================

const LOG_DIR = join(homedir(), ".deepagents", "logs");
const LOG_FILE = join(LOG_DIR, "tui.log");

/** Maximum log file size before rotation (5 MB). */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/**
 * Get the absolute path to the TUI log file (exposed for the /log command).
 */
export function getLogFilePath(): string {
  return LOG_FILE;
}

// =============================================================================
// Activation logic
// =============================================================================

/** True if debug logging is active for this process. */
let _debugEnabled = false;

export function isDebugEnabled(): boolean {
  return _debugEnabled;
}

/**
 * Parse a "truthy" env value.
 * @returns 0 (off), 1 (on), or 2 (verbose/trace)
 */
function _parseDebugValue(raw: string | undefined): number {
  if (!raw) return 0;
  const lower = raw.toLowerCase().trim();
  if (lower === "2" || lower === "verbose" || lower === "trace") return 2;
  if (["1", "true", "yes", "on"].includes(lower)) return 1;
  return 0;
}

// =============================================================================
// File stream — a minimal WritableStream compatible with core's configure()
// =============================================================================

/**
 * Rotate the log file if it exceeds MAX_LOG_SIZE by renaming the current
 * file to `.1` and starting fresh. Keeps only one backup.
 */
function _rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    if (statSync(LOG_FILE).size < MAX_LOG_SIZE) return;
    const backup = `${LOG_FILE}.1`;
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(LOG_FILE, backup);
  } catch {
    // Rotation failure is non-fatal — we'll just keep appending.
  }
}

/**
 * Create a `NodeJS.WritableStream` that appends each write to the log file.
 *
 * Uses synchronous `appendFileSync` per write so logs survive an unexpected
 * process crash (a long-lived `fs.createWriteStream` may not flush its
 * buffer before exit). The overhead is negligible for TUI logging volumes.
 */
function _createFileStream(): NodeJS.WritableStream {
  mkdirSync(LOG_DIR, { recursive: true });
  _rotateIfNeeded();

  return {
    write(chunk: any): boolean {
      try {
        appendFileSync(LOG_FILE, chunk, { encoding: "utf-8" });
      } catch {
        // If we can't write the log file (permissions, disk full, etc.),
        // silently give up — logging must never crash the TUI.
      }
      return true;
    },
    end(): void {},
    destroy(): void {},
  } as unknown as NodeJS.WritableStream;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Initialize TUI logging. Call once at startup (before `program.parse()`).
 *
 * @param debugCount - number of times `--debug` was passed (0 = off, 1+ = on,
 *   2+ = verbose/trace).
 * @param envValue  - value of `OCTOPUS_TUI_DEBUG` env var.
 */
export function initTuiLogging(debugCount: number, envValue?: string): void {
  const envLevel = _parseDebugValue(envValue);
  const level = Math.max(envLevel, debugCount);

  _debugEnabled = level > 0;

  if (_debugEnabled) {
    const stream = _createFileStream();
    configure({
      level: LogLevel.DEBUG,
      stream,
      colors: false, // ANSI codes would corrupt the file.
    });
    const logger = coreGetLogger("tui.init");
    logger.info(
      `TUI debug logging started (verbose=${level >= 2}, file=${LOG_FILE})`,
    );
  } else {
    // Normal mode: still configure core so getLogger() works everywhere,
    // but suppress INFO/DEBUG. WARN/ERROR go to stderr (harmless in TUI
    // because those levels are only hit on real problems).
    configure({
      level: LogLevel.WARN,
      stream: process.stderr,
      colors: process.stderr.isTTY ?? false,
    });
  }
}

/**
 * Get a logger instance (thin re-export of core's cached factory).
 * Usage: `const logger = getLogger("tui.adapter");`
 */
export function getLogger(name: string): Logger {
  return coreGetLogger(name);
}

/** Re-export LogLevel for callers that want to compare. */
export { LogLevel };
