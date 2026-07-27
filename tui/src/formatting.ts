// =============================================================================
// Text formatting helpers — time, duration, tokens.
// Equivalent to Python tui.formatting.
// Kept dependency-free for broad importability.
// =============================================================================

import { execFileSync } from "node:child_process";
import { platform } from "node:os";

// =============================================================================
// Clock detection
// =============================================================================

let _uses24Hour: boolean | null = null;

/**
 * Detect whether the system uses 24-hour time format.
 * Equivalent to Python `uses_24_hour_clock()`.
 */
export function uses24HourClock(): boolean {
  if (_uses24Hour !== null) return _uses24Hour;

  // Check macOS preference
  if (platform() === "darwin") {
    try {
      const result = execFileSync("defaults", [
        "read",
        "-g",
        "AppleICUForce24HourTime",
      ], { encoding: "utf-8", timeout: 2000 }).trim();
      if (result === "1") {
        _uses24Hour = true;
        return true;
      }
    } catch {
      // Preference not set or not readable
    }
  }

  // Probe via locale
  try {
    const now = new Date();
    const formatted = now.toLocaleTimeString([], { hour: "numeric" });
    // If the string contains AM/PM (case-insensitive), it's 12-hour
    _uses24Hour = !/[ap]m/i.test(formatted);
  } catch {
    _uses24Hour = false;
  }
  return _uses24Hour!;
}

// =============================================================================
// Duration formatting
// =============================================================================

/**
 * Format a duration in seconds to a human-readable string.
 * Equivalent to Python `format_duration()`.
 *
 * Examples: "5s", "2.3s", "5m 12s", "1h 23m 4s"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return "0s";
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  return `${minutes}m ${secs}s`;
}

// =============================================================================
// Timestamp formatting
// =============================================================================

/**
 * Format a Unix timestamp for display in chat messages.
 * Respects 12/24-hour clock preference.
 *
 * Equivalent to Python `format_message_timestamp()`.
 */
export function formatMessageTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: !uses24HourClock(),
  };

  // If the date is not today, include the date
  const now = new Date();
  if (
    date.getFullYear() !== now.getFullYear() ||
    date.getMonth() !== now.getMonth() ||
    date.getDate() !== now.getDate()
  ) {
    options.month = "short";
    options.day = "numeric";
  }

  return date.toLocaleString([], options);
}

// =============================================================================
// Relative time
// =============================================================================

/**
 * Format a relative time string (e.g., "2 minutes ago", "just now").
 * Used for thread listing.
 *
 * Equivalent to Python `format_relative_timestamp()`.
 */
export function formatRelativeTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 0) return "just now";
  if (diffSeconds < 60) return "just now";
  if (diffSeconds < 3600) {
    const mins = Math.floor(diffSeconds / 60);
    return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  }
  if (diffSeconds < 86400) {
    const hours = Math.floor(diffSeconds / 3600);
    return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  }
  if (diffSeconds < 604800) {
    const days = Math.floor(diffSeconds / 86400);
    return `${days} day${days !== 1 ? "s" : ""} ago`;
  }

  return date.toLocaleDateString();
}

// =============================================================================
// Token formatting
// =============================================================================

/**
 * Format a token count for display.
 * Equivalent to Python `format_token_count()`.
 *
 * Examples: "500", "12.5K", "1.2M"
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// =============================================================================
// Path formatting
// =============================================================================

/**
 * Format a path for display — truncate to a reasonable length,
 * replacing the home directory with ~.
 *
 * Equivalent to Python `format_path()`.
 */
export function formatPath(path: string): string {
  // Don't import os at module level for broad importability
  // but we can use process.env.HOME / USERPROFILE
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && path.startsWith(home)) {
    path = "~" + path.slice(home.length);
  }

  // Truncate long paths
  if (path.length > 60) {
    const parts = path.split(/[/\\]/);
    if (parts.length > 3) {
      return parts[0] + "/.../" + parts.slice(-2).join("/");
    }
    return path.slice(0, 57) + "...";
  }

  return path;
}
