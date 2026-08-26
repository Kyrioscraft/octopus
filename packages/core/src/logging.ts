/**
 * Lightweight logging module — equivalent to Python's `logging` stdlib usage.
 *
 * Design:
 *   - No external dependencies (no winston, pino, etc.)
 *   - Format matches Python cortex: `HH:MM:SS [LEVEL   ] name | message`
 *   - AsyncLocalStorage for request-context injection (request_id, thread_id, user_id)
 *   - ANSI colors for ERROR/WARNING in TTY environments
 *   - Level filtering via `OCTOPUS_LOG_LEVEL` env var
 *
 * Usage:
 *   import { getLogger } from "@octopus/core";
 *   const logger = getLogger("my.module");
 *   logger.info("Something happened");
 *   logger.exception("Caught error", err);
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
}

export interface LogContext {
  request_id?: string;
  thread_id?: string;
  user_id?: string;
  [key: string]: string | undefined;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  exception(message: string, error: unknown): void;
}

interface ConfigureOptions {
  /** Minimum log level (default: INFO). Reads OCTOPUS_LOG_LEVEL env var. */
  level?: string | LogLevel;
  /** Output stream (default: process.stderr). */
  stream?: NodeJS.WritableStream;
  /** Enable ANSI colors (default: auto-detect TTY). */
  colors?: boolean;
}

// =============================================================================
// State
// =============================================================================

const _contextStore = new AsyncLocalStorage<LogContext>();

let _level: LogLevel = LogLevel.INFO;
let _stream: NodeJS.WritableStream = process.stderr;
let _colors: boolean = process.stderr.isTTY ?? false;
let _logFileStream: NodeJS.WritableStream | null = null;

// =============================================================================
// ANSI escape codes
// =============================================================================

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

// =============================================================================
// Formatting
// =============================================================================

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

function _formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function _formatContext(ctx?: LogContext): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.request_id) parts.push(`request_id=${ctx.request_id}`);
  if (ctx.thread_id) parts.push(`thread_id=${ctx.thread_id}`);
  if (ctx.user_id) parts.push(`user_id=${ctx.user_id}`);
  // Extra context keys
  for (const [k, v] of Object.entries(ctx)) {
    if (!["request_id", "thread_id", "user_id"].includes(k) && v !== undefined) {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? `  [${parts.join(" ")}]` : "";
}

function _colorize(level: LogLevel, text: string): string {
  if (!_colors) return text;
  switch (level) {
    case LogLevel.ERROR: return ANSI.red + text + ANSI.reset;
    case LogLevel.WARN:  return ANSI.yellow + text + ANSI.reset;
    default:             return text;
  }
}

// =============================================================================
// Logger implementation
// =============================================================================

function _log(level: LogLevel, name: string, message: string, ...args: unknown[]): void {
  if (level < _level) return;

  const ctx = _contextStore.getStore();
  const time = _formatTime();
  const label = LEVEL_LABELS[level].padEnd(7);
  const formatted = `${time} [${label}] ${name.padEnd(12)} | ${message}`;
  const extra = _formatContext(ctx);

  // Format args
  let argsStr = "";
  for (const arg of args) {
    if (arg instanceof Error) {
      argsStr += `\n  ${ANSI.dim}${arg.stack ?? arg.message}${_colors ? ANSI.reset : ""}`;
    } else if (typeof arg === "string") {
      argsStr += ` ${arg}`;
    } else if (arg !== undefined && arg !== null) {
      try {
        argsStr += ` ${JSON.stringify(arg)}`;
      } catch {
        argsStr += ` ${String(arg)}`;
      }
    }
  }

  const line = _colorize(level, formatted + argsStr + extra) + "\n";
  _stream.write(line);
  // Optional file mirror (OCTOPUS_LOG_FILE) — for tool-trace diagnostics.
  if (_logFileStream) {
    try {
      _logFileStream.write(line.replace(/\x1b\[[0-9;]*m/g, ""));
    } catch {
      /* file mirror must never break logging */
    }
  }
}

function _createLogger(name: string): Logger {
  return {
    debug(message: string, ...args: unknown[]) {
      _log(LogLevel.DEBUG, name, message, ...args);
    },
    info(message: string, ...args: unknown[]) {
      _log(LogLevel.INFO, name, message, ...args);
    },
    warn(message: string, ...args: unknown[]) {
      _log(LogLevel.WARN, name, message, ...args);
    },
    error(message: string, ...args: unknown[]) {
      _log(LogLevel.ERROR, name, message, ...args);
    },
    exception(message: string, error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      _log(LogLevel.ERROR, name, message, err);
    },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Configure the logging system.
 *
 * Called once at startup. Reads `OCTOPUS_LOG_LEVEL` from env if no level given.
 *
 * Equivalent to Python `logging.basicConfig()` + `setup_logging()`.
 */
export function configure(options?: ConfigureOptions): void {
  // Resolve level
  if (options?.level !== undefined) {
    if (typeof options.level === "string") {
      _level = _parseLevel(options.level);
    } else {
      _level = options.level;
    }
  } else {
    const envLevel = process.env["OCTOPUS_LOG_LEVEL"];
    if (envLevel) _level = _parseLevel(envLevel);
  }

  // Resolve stream
  if (options?.stream) _stream = options.stream;

  // Resolve colors
  if (options?.colors !== undefined) {
    _colors = options.colors;
  }

  // Resolve file mirror: OCTOPUS_LOG_FILE appends every record (ANSI-stripped)
  if (!_logFileStream && process.env["OCTOPUS_LOG_FILE"]) {
    try {
      const file = process.env["OCTOPUS_LOG_FILE"];
      const dir = dirname(file);
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
      _logFileStream = createWriteStream(file, { flags: "a" });
    } catch {
      // Ignore — file mirror is best-effort
    }
  }
}

function _parseLevel(s: string): LogLevel {
  const upper = s.toUpperCase();
  switch (upper) {
    case "DEBUG":   return LogLevel.DEBUG;
    case "INFO":    return LogLevel.INFO;
    case "WARN":
    case "WARNING": return LogLevel.WARN;
    case "ERROR":   return LogLevel.ERROR;
    default:        return LogLevel.INFO;
  }
}

/** Logger factory cache — same name returns the same logger instance. */
const _loggerCache = new Map<string, Logger>();

/**
 * Get a named logger.
 *
 * Equivalent to Python `logging.getLogger(__name__)`.
 * Callers should pass a short dotted name like `"chat.router"` or `"agent.graph"`.
 */
export function getLogger(name: string): Logger {
  const cached = _loggerCache.get(name);
  if (cached) return cached;
  const logger = _createLogger(name);
  _loggerCache.set(name, logger);
  return logger;
}

// =============================================================================
// Async context — used by middleware to inject request_id/thread_id/user_id.
// Equivalent to Python's `meta` dict flowing through the call chain.
// =============================================================================

/**
 * Run a function within a logging context.
 *
 * All log calls inside `fn` (and any async operations it spawns) will
 * automatically include the context tags.
 *
 * Used by request middleware to inject `request_id`, `thread_id`, `user_id`.
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  return _contextStore.run(ctx, fn);
}

/**
 * Read the current logging context (if any).
 *
 * Used by route handlers to retrieve the auto-generated request_id
 * for stamping onto NDJSON streaming chunks.
 */
export function getLogContext(): LogContext | undefined {
  return _contextStore.getStore();
}
