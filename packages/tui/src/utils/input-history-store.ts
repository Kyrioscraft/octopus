// =============================================================================
// input-history-store — persistent input history for the chat input box.
//
// Stores user-submitted inputs (most-recent-first) to a JSON file under
// ~/.deepagents/.state/ so that pressing the Up arrow recalls inputs across
// TUI sessions, not just within the current one.
//
// The on-disk format is a plain JSON array of strings, newest first. Writes
// are debounced so rapid submits don't hammer the filesystem; a final flush
// also runs on process exit.
// =============================================================================

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { getLogger } from "./logging.js";

const logger = getLogger("tui.input-history");

const STATE_DIR = join(homedir(), ".deepagents", ".state");
const HISTORY_FILE = join(STATE_DIR, "tui-input-history.json");

/** Cap on the number of entries persisted (matches InputHistory's default). */
const MAX_ENTRIES = 1000;
/** Debounce window for flushing appended entries to disk (ms). */
const FLUSH_DEBOUNCE_MS = 300;

let cache: string[] | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Load the persisted input history (newest-first). Reads from disk at most
 * once per process; subsequent calls return the cached array. On any read
 * error (missing file, corrupt JSON) the history silently starts empty.
 */
export function loadInputHistory(): string[] {
  if (cache) return cache;
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cache = parsed.filter((e) => typeof e === "string").slice(0, MAX_ENTRIES);
        return cache;
      }
    }
  } catch (err) {
    logger.debug("Failed to read input history; starting empty", err);
  }
  cache = [];
  return cache;
}

/**
 * Append a new input to the front of the history and schedule a debounced
 * disk flush. Duplicate-consecutive entries are collapsed. Safe to call on
 * every submit — no-op for blank input.
 */
export function appendInputHistory(entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const list = loadInputHistory();
  // Collapse duplicates of the immediately-previous entry.
  if (list[0] === trimmed) return;
  // Remove any older copy so the newest occurrence wins (most-recent-first).
  const filtered = list.filter((e) => e !== trimmed);
  filtered.unshift(trimmed);
  cache = filtered.slice(0, MAX_ENTRIES);
  dirty = true;
  scheduleFlush();
}

/** Write the current cache to disk immediately (skipped if not dirty). */
function flushNow(): void {
  if (!dirty || !cache) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(cache, null, 0), "utf-8");
    dirty = false;
  } catch (err) {
    logger.debug("Failed to persist input history", err);
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, FLUSH_DEBOUNCE_MS);
  // Don't keep the process alive solely for this timer.
  if (flushTimer && typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}

// Best-effort final flush when the TUI process exits.
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("exit", flushNow);
}
