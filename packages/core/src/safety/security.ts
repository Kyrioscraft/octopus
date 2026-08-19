/**
 * Unicode security utilities — detect dangerous characters, sanitize untrusted
 * MCP/tool output, and validate URL safety against homograph attacks.
 *
 * Equivalent to Python `cortex.unicode_security`.
 */

import { getLogger } from "../logging.js";

const logger = getLogger("unicode.security");

// =============================================================================
// Types — equivalent to Python `UnicodeIssue` + `UrlSafetyResult`.
// =============================================================================

export interface UnicodeIssue {
  category: string;
  description: string;
  position?: number;
  context: string;
}

export interface UrlSafetyResult {
  isSafe: boolean;
  issues: UnicodeIssue[];
  originalUrl: string;
  normalizedUrl?: string;
}

// =============================================================================
// Dangerous character detection.
// Equivalent to Python `detect_dangerous_unicode()`.
// =============================================================================

/**
 * Unicode code-point ranges that are considered dangerous when supplied by
 * untrusted sources (MCP tool output, generated code, prompt-injected content).
 *
 * DETECTION is read-only and never raises. SANITIZATION replaces detected
 * characters with `\uFFFD` (REPLACEMENT CHARACTER) so downstream consumers
 * see a safe token rather than the raw dangerous glyph.
 */
const DANGEROUS_CATEGORIES: { name: string; ranges: [number, number][] }[] = [
  {
    name: "Bidirectional override",
    ranges: [
      [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
      [0x2066, 0x2069], // LRI, RLI, FSI, PDI
    ],
  },
  {
    name: "Zero-width",
    ranges: [
      [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
      [0x2028, 0x2029], // LINE SEPARATOR, PARAGRAPH SEPARATOR
      [0xfeff, 0xfeff], // BOM / ZWNBSP
      [0x00ad, 0x00ad], // SOFT HYPHEN
      [0x2060, 0x2064], // WJ, ...
    ],
  },
  {
    name: "Interlinear annotation",
    ranges: [
      [0xfff9, 0xfffb], // IAA, IAS, IAT
    ],
  },
  {
    name: "Deprecated format",
    ranges: [
      [0x206a, 0x206f], // ISS, ASS, IAFS, AAFS, NADS, NODS, ...
    ],
  },
  {
    name: "Tag characters",
    ranges: [
      [0xe0001, 0xe007f], // LANGUAGE TAG + tag space..CANCEL TAG
    ],
  },
  {
    name: "Hangul fillers",
    ranges: [
      [0x115f, 0x1160], // HANGUL CHOSEONG FILLER, HANGUL JUNGSEONG FILLER
      [0x3164, 0x3164], // HANGUL FILLER
      [0xffa0, 0xffa0], // HALFWIDTH HANGUL FILLER
    ],
  },
];

/**
 * Detect dangerous Unicode characters in a text string.
 *
 * Scans `text` for code points that can alter text direction, inject invisible
 * content, or confuse rendering. Returns a list of issues found (empty when
 * the text is safe).
 *
 * @param text  String to scan.
 * @returns List of `UnicodeIssue` objects found.
 *
 * Equivalent to Python `detect_dangerous_unicode()`.
 */
export function detectDangerousUnicode(text: string): UnicodeIssue[] {
  const issues: UnicodeIssue[] = [];

  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) continue;

    for (const category of DANGEROUS_CATEGORIES) {
      for (const [lo, hi] of category.ranges) {
        if (codePoint >= lo && codePoint <= hi) {
          const contextStart = Math.max(0, i - 10);
          const contextEnd = Math.min(text.length, i + 10);
          issues.push({
            category: category.name,
            description: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} (${category.name})`,
            position: i,
            context: text.slice(contextStart, contextEnd),
          });
        }
      }
    }

    // Skip surrogate pairs
    if (codePoint > 0xffff) i++;
  }

  return issues;
}

/**
 * Strip dangerous Unicode characters from a string.
 *
 * Replaces every detected dangerous code point with `\uFFFD` (REPLACEMENT
 * CHARACTER). Safe text passes through unchanged.
 *
 * @param text  String to sanitize.
 * @returns Sanitized string with dangerous characters replaced.
 *
 * Equivalent to Python `strip_dangerous_unicode()`.
 */
export function stripDangerousUnicode(text: string): string {
  const issues = detectDangerousUnicode(text);
  if (issues.length === 0) return text;

  // Build a set of dangerous positions for O(1) lookup
  const dangerousPositions = new Set(issues.map((iss) => iss.position!).filter((p) => p !== undefined));

  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (dangerousPositions.has(i)) {
      result += "\uFFFD";
      // Skip surrogate pairs
      const cp = text.codePointAt(i);
      if (cp !== undefined && cp > 0xffff) i++;
    } else {
      result += text[i];
    }
  }

  return result;
}

/**
 * Sanitize control characters in untrusted MCP/tool output.
 *
 * Replaces ASCII control characters (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F)
 * with `\uFFFD`. Preserves tab (0x09), LF (0x0A), and CR (0x0D).
 *
 * @param text  String to sanitize.
 * @returns Sanitized string.
 *
 * Equivalent to Python `sanitize_control_chars()`.
 */
export function sanitizeControlChars(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (
      (ch >= 0x00 && ch <= 0x08) ||
      (ch >= 0x0b && ch <= 0x0c) ||
      (ch >= 0x0e && ch <= 0x1f) ||
      ch === 0x7f
    ) {
      result += "\uFFFD";
    } else {
      result += text[i];
    }
  }
  return result;
}

/**
 * Summarize a list of Unicode issues into a human-readable warning.
 *
 * @param issues  List of issues from `detectDangerousUnicode`.
 * @returns A single-line summary string, or empty string if no issues.
 *
 * Equivalent to Python `summarize_issues()`.
 */
export function summarizeIssues(issues: UnicodeIssue[]): string {
  if (issues.length === 0) return "";

  const byCategory = new Map<string, number>();
  for (const issue of issues) {
    byCategory.set(issue.category, (byCategory.get(issue.category) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [category, count] of byCategory) {
    parts.push(`${count} ${category}${count > 1 ? "s" : ""}`);
  }

  return `Found ${issues.length} dangerous Unicode character${issues.length > 1 ? "s" : ""}: ${parts.join(", ")}`;
}

// =============================================================================
// URL safety — equivalent to Python `check_url_safety()`.
// =============================================================================

/**
 * Check a URL for homograph / confusable character attacks.
 *
 * Performs basic checks:
 *   - Detects dangerous Unicode characters in the URL string
 *   - Warns about mixed-script URLs (potential homograph attacks)
 *
 * @param url  URL string to check.
 * @returns A `UrlSafetyResult` with safety status and any issues found.
 *
 * Equivalent to Python `check_url_safety()`.
 */
export function checkUrlSafety(url: string): UrlSafetyResult {
  const issues: UnicodeIssue[] = [];

  try {
    // Check for dangerous Unicode characters in the URL
    const dangerousIssues = detectDangerousUnicode(url);
    issues.push(...dangerousIssues);

    // Simple mixed-script detection: scan for characters from different
    // script blocks in the hostname portion.
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      // Detect mixed Latin + Cyrillic (common homograph vectors)
      const hasCyrillic = /[\u0400-\u04FF]/.test(hostname);
      const hasLatin = /[a-zA-Z]/.test(hostname);

      if (hasCyrillic && hasLatin) {
        issues.push({
          category: "Mixed script",
          description: `Hostname "${hostname}" contains both Latin and Cyrillic characters — possible homograph attack`,
          context: hostname,
        });
      }

      // Detect mixed Latin + Greek
      const hasGreek = /[\u0370-\u03FF]/.test(hostname);
      if (hasGreek && hasLatin) {
        issues.push({
          category: "Mixed script",
          description: `Hostname "${hostname}" contains both Latin and Greek characters — possible homograph attack`,
          context: hostname,
        });
      }
    } catch {
      // URL parsing failed — carry on with only Unicode issues
    }
  } catch (err) {
    logger.debug(`URL safety check failed for ${url}: ${String(err)}`);
    return { isSafe: false, issues: [], originalUrl: url };
  }

  return {
    isSafe: issues.length === 0,
    issues,
    originalUrl: url,
  };
}

/**
 * Iterate all string values in an object tree (recursively).
 *
 * Walks plain objects and arrays, collecting every string leaf value.
 * Useful for batch-sanitizing untrusted JSON payloads.
 *
 * @param obj  Root object/array/value to walk.
 * @returns Array of all string leaf values found.
 *
 * Equivalent to Python `iter_string_values()`.
 */
export function iterStringValues(obj: unknown): string[] {
  const results: string[] = [];

  function walk(value: unknown): void {
    if (typeof value === "string") {
      results.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        walk(v);
      }
    }
  }

  walk(obj);
  return results;
}
