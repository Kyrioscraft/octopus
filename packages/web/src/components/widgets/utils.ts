/**
 * Generic, domain-agnostic helpers shared across the app (string, path, and
 * language helpers). Kept in `widgets/` because they are reusable primitives
 * with no toolcall/conversation-specific semantics — unlike the tool-display
 * logic that lives in `rows/tools/registry.tsx`.
 */

/**
 * Truncate a string to maxLen characters, appending "…" if shortened.
 */
export function truncate(s: string | undefined | null, maxLen: number): string {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/**
 * Count the number of lines in a (possibly undefined/empty) string. Used for
 * the +N/-M tags on file-edit cards (industry-standard summary, à la Cline).
 */
export function countLines(s: string | undefined | null): number {
  if (!s) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed === "") return 0;
  return trimmed.split("\n").length;
}

/**
 * Extract the basename from a path. Works with both / and \ separators.
 */
export function basename(p: string | undefined | null): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Infer a refractor/prism language name from a file path's extension. Used to
 * drive syntax highlighting in the diff viewer and code blocks.
 */
export function inferLanguage(filePath: string | undefined | null): string {
  if (!filePath) return "text";
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", html: "html", htm: "html", xml: "xml", css: "css", scss: "scss",
    json: "json", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
    md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", vue: "vue", svelte: "svelte", dockerfile: "docker",
  };
  return map[ext] ?? "text";
}
