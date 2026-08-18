/**
 * Wildcard matching for permission patterns.
 *
 * Supported syntax (deliberately small — enough for tool/permission rules):
 *   *  — any run of characters, INCLUDING path separators
 *   ** — same as * (kept for readability in path rules)
 *   ?  — exactly one character
 *   everything else matches literally
 *
 * Matching is case-insensitive on win32, sensitive elsewhere — mirroring
 * path-comparison conventions. Inputs are normalized (backslashes →
 * forward slashes, trailing slashes trimmed) before comparison so rules
 * written with `/` work on Windows paths.
 */

const IS_WIN = process.platform === "win32";

/** Normalize a subject or pattern for comparison. */
function normalize(s: string): string {
  let out = s.replace(/\\/g, "/");
  // Collapse "./foo" → "foo" so cwd-relative subjects match bare patterns.
  if (out.startsWith("./")) out = out.slice(2);
  // Trim trailing slash (but keep a bare "/").
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Escape a literal string for embedding in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a wildcard pattern into a RegExp (cached — rules are reused). */
const cache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;

  const norm = normalize(pattern);
  let src = "^";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*") {
      // '*' and '**' behave identically: any run, including separators.
      src += ".*";
      while (norm[i + 1] === "*") i++;
    } else if (ch === "?") {
      src += ".";
    } else {
      src += escapeRegex(ch);
    }
  }
  src += "$";

  const flags = IS_WIN ? "i" : "";
  const re = new RegExp(src, flags);
  if (cache.size < 500) cache.set(pattern, re);
  return re;
}

/** Test whether `subject` matches the wildcard `pattern`. */
export function wildcardMatch(pattern: string, subject: string): boolean {
  if (pattern === "*" || pattern === "") return true;
  return compile(pattern).test(normalize(subject));
}
