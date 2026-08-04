// =============================================================================
// Lightweight Markdown → Ink renderer.
//
// Parses a subset of Markdown sufficient for agent responses:
//   - Fenced code blocks (```)
//   - Inline code (`code`)
//   - Bold (**text**) and italic (*text*)
//   - Headings (#, ##, ###)
//   - Unordered lists (-, *) and ordered lists (1.)
//   - Blockquotes (>)
//   - Horizontal rules (---)
//
// No external dependencies — a small regex-based block parser. Designed for
// streaming: unterminated code fences are rendered as best-effort text until
// the closing fence arrives.
//
// Equivalent intent to the web frontend's rich markdown rendering, but
// implemented independently for Ink's <Box>/<Text> primitives.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";

// =============================================================================
// Inline parsing — bold, italic, inline code
// =============================================================================

/** Tokens emitted by the inline parser. */
type InlineToken =
  | { type: "text"; value: string }
  | { type: "bold"; value: InlineToken[] }
  | { type: "italic"; value: InlineToken[] }
  | { type: "code"; value: string };

/**
 * Parse a single line of inline markdown into renderable tokens.
 * Handles `code`, **bold**, and *italic* (non-greedy, left-to-right).
 */
function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let buf = "";

  const flushBuf = () => {
    if (buf) {
      tokens.push({ type: "text", value: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    // Inline code: `...`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flushBuf();
        tokens.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Bold: **...**
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flushBuf();
        tokens.push({ type: "bold", value: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    // Italic: *...*  (single asterisk, not part of **)
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i && text[end + 1] !== "*") {
        flushBuf();
        tokens.push({ type: "italic", value: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flushBuf();
  return tokens;
}

/** Render inline tokens as a sequence of <Text> elements inside a single line. */
function renderInlineTokens(tokens: InlineToken[]): React.ReactNode {
  return tokens.map((token, idx) => {
    switch (token.type) {
      case "text":
        return <Text key={idx}>{token.value}</Text>;
      case "bold":
        return (
          <Text key={idx} bold>
            {renderInlineTokens(token.value)}
          </Text>
        );
      case "italic":
        return (
          <Text key={idx} italic>
            {renderInlineTokens(token.value)}
          </Text>
        );
      case "code":
        return (
          <Text key={idx} backgroundColor={COLORS.reasoning} color="white">
            {" "}
            {token.value}{" "}
          </Text>
        );
      default:
        return null;
    }
  });
}

// =============================================================================
// Block parsing — code fences, headings, lists, quotes, paragraphs
// =============================================================================

type Block =
  | { type: "code"; lang: string; lines: string[] }
  | { type: "heading"; level: number; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "hr" }
  | { type: "paragraph"; lines: string[] };

/** Parse the full markdown text into block-level elements. */
function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "paragraph", lines: [...para] });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^\s*```(.*)$/);
    if (fenceMatch) {
      flushPara();
      const lang = (fenceMatch[1] ?? "").trim();
      const codeLines: string[] = [];
      i++;
      // Consume until closing fence (or end of input — streaming tolerance)
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing fence if present
      if (i < lines.length) i++;
      blocks.push({ type: "code", lang, lines: codeLines });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushPara();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line) && !line.trim().includes(" ")) {
      // Ensure it's really a rule (---, ***, ___), not a list of dashes
      const stripped = line.replace(/\s/g, "");
      if (stripped.length >= 3 && new Set(stripped).size === 1) {
        flushPara();
        blocks.push({ type: "hr" });
        i++;
        continue;
      }
    }

    // Blockquote
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushPara();
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qm = lines[i].match(/^>\s?(.*)$/);
        if (!qm) break;
        quoteLines.push(qm[1]);
        i++;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    // List (group consecutive items)
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      flushPara();
      const ordered = !!olMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const um = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const om = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (ordered && om) {
          items.push(om[1]);
          i++;
        } else if (!ordered && um) {
          items.push(um[1]);
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Blank line — paragraph separator
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }

    // Default: accumulate into paragraph
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

// =============================================================================
// Simple syntax highlighting for code blocks
// =============================================================================

/** A small set of common language keywords for basic token coloring. */
const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "import", "export", "from", "class", "new", "try", "catch", "finally",
  "async", "await", "type", "interface", "enum", "extends", "implements",
  "public", "private", "protected", "static", "readonly", "void", "null",
  "undefined", "true", "false", "this", "super", "default", "switch", "case",
  "break", "continue", "throw", "typeof", "instanceof", "in", "of", "as",
  "yield", "delete",
  // Python
  "def", "elif", "lambda", "pass", "with", "raise", "except", "None", "True",
  "False", "self", "and", "or", "not", "is", "global", "nonlocal",
]);

/** Render a single code line with naive keyword highlighting. */
function renderCodeLine(line: string, key: React.Key): React.ReactNode {
  // Split on word boundaries so keywords are isolated
  const parts = line.split(/(\b)/);
  return (
    <Box key={key}>
      <Text> </Text>
      {parts.map((part, idx) => {
        if (KEYWORDS.has(part)) {
          return (
            <Text key={idx} color={COLORS.warning} bold>
              {part}
            </Text>
          );
        }
        // String literals (simple single/double quoted)
        return (
          <Text key={idx} dimColor={!part.trim()}>
            {part}
          </Text>
        );
      })}
    </Box>
  );
}

// =============================================================================
// Component
// =============================================================================

export interface MarkdownProps {
  /** The markdown source text. */
  children: string;
}

/**
 * Render markdown content as Ink components.
 *
 * Designed for streaming: partial / unterminated code fences render
 * best-effort so the UI updates smoothly as tokens arrive.
 */
export const Markdown: React.FC<MarkdownProps> = ({ children }) => {
  const blocks = parseBlocks(children);

  return (
    <Box flexDirection="column">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case "code":
            return (
              <Box
                key={idx}
                flexDirection="column"
                borderStyle="round"
                borderColor={COLORS.reasoning}
                marginY={0}
                paddingX={0}
              >
                {block.lang && (
                  <Text dimColor> {block.lang}</Text>
                )}
                {block.lines.map((line, li) => renderCodeLine(line, li))}
              </Box>
            );

          case "heading": {
            const prefix = "#".repeat(block.level);
            return (
              <Box key={idx}>
                <Text bold color={COLORS.primary}>
                  {prefix} {block.content}
                </Text>
              </Box>
            );
          }

          case "list":
            return (
              <Box key={idx} flexDirection="column">
                {block.items.map((item, li) => (
                  <Box key={li}>
                    <Text dimColor>{block.ordered ? `${li + 1}.` : "•"} </Text>
                    <Text>{renderInlineTokens(parseInline(item))}</Text>
                  </Box>
                ))}
              </Box>
            );

          case "quote":
            return (
              <Box key={idx} flexDirection="column" paddingLeft={1}>
                {block.lines.map((line, qi) => (
                  <Box key={qi}>
                    <Text color={COLORS.reasoning}>│ </Text>
                    <Text dimColor>{renderInlineTokens(parseInline(line))}</Text>
                  </Box>
                ))}
              </Box>
            );

          case "hr":
            return (
              <Text key={idx} dimColor>
                {"─".repeat(40)}
              </Text>
            );

          case "paragraph":
            return (
              <Box key={idx} flexDirection="column">
                {block.lines.map((line, pi) => (
                  <Box key={pi}>
                    <Text>{renderInlineTokens(parseInline(line))}</Text>
                  </Box>
                ))}
              </Box>
            );

          default:
            return null;
        }
      })}
    </Box>
  );
};
