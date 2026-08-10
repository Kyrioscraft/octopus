// =============================================================================
// Lightweight markdown → plain-text stripper.
//
// Removes markdown syntax characters to produce stable plain-text output for
// the terminal. Unlike a full markdown parser (marked + remend), this is a
// single-pass O(n) string transform.
// =============================================================================

export function stripMarkdown(text: string): string {
  if (!text) return "";

  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```|~~~)(.*)$/);
    if (fenceMatch) {
      if (!inCodeFence) { inCodeFence = true; continue; }
      else { inCodeFence = false; continue; }
    }
    if (inCodeFence) { result.push("  " + line); continue; }

    let processed = line;
    processed = processed.replace(/^(\s{0,3})(#{1,6})\s+(.*)$/, "$1$3");

    if (/^(\s*[-*_]){3,}\s*$/.test(processed) && !processed.trim().includes(" ")) {
      const stripped = processed.replace(/\s/g, "");
      if (stripped.length >= 3 && new Set(stripped).size === 1) {
        result.push("─".repeat(40));
        continue;
      }
    }

    processed = processed.replace(/^(\s*)>\s?/, "$1");
    processed = processed.replace(/^(\s*)([-*+])\s+/, "$1• ");
    processed = processed.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    processed = processed.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)");
    processed = processed.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
    processed = processed.replace(/\*\*([^*]+)\*\*/g, "$1");
    processed = processed.replace(/__([^_]+)__/g, "$1");
    processed = processed.replace(/~~([^~]+)~~/g, "$1");
    processed = processed.replace(/`([^`]+)`/g, "$1");
    processed = processed.replace(/\*([^*\n]+)\*/g, "$1");
    processed = processed.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
    processed = processed.replace(/\s*\|\s*/g, "  ");

    result.push(processed);
  }

  return result.join("\n");
}
