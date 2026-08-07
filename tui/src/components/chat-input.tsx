// =============================================================================
// Chat input component — multi-line text input with slash-command autocomplete,
// input history, mode switching, and paste/drag-drop path detection.
//
// Equivalent to Python tui.widgets.chat_input.
// =============================================================================

import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { SLASH_COMMANDS, buildSkillCommands } from "../command-registry.js";
import type { CommandEntry } from "../command-registry.js";
import type { AppPhase, InputMode } from "../types.js";
import { getGlyphs, MODE_DISPLAY_GLYPHS, detectModePrefix } from "../terminal/config-ui.js";
import { COLORS } from "../terminal/theme.js";

// =============================================================================
// Props
// =============================================================================

export interface ChatInputProps {
  /** Current app phase (controls whether input is enabled). */
  phase: AppPhase;
  /** Current input mode. */
  inputMode: InputMode;
  /** Callback when mode changes. */
  onModeChange: (mode: InputMode) => void;
  /** Callback when user submits text. */
  onSubmit: (text: string, mode: InputMode) => void;
  /** Discovered skills for autocomplete (optional). */
  skills?: { name: string; description: string }[];
  /**
   * Merged slash-command entries (remote + local). When provided, these
   * replace the module-level SLASH_COMMANDS constant so the autocomplete
   * reflects the server-authoritative list. Falls back to SLASH_COMMANDS
   * when not supplied (e.g. before the initial fetch completes).
   */
  commands?: CommandEntry[];
}

// =============================================================================
// History manager (in-memory; persisted to JSONL in Phase 6)
// =============================================================================

class InputHistory {
  #entries: string[] = [];
  #index: number = -1;
  readonly #maxEntries: number;

  constructor(maxEntries = 1000) {
    this.#maxEntries = maxEntries;
  }

  add(entry: string): void {
    if (entry.trim()) {
      this.#entries.unshift(entry);
      if (this.#entries.length > this.#maxEntries) {
        this.#entries.pop();
      }
    }
    this.#index = -1;
  }

  previous(current: string): string | null {
    if (this.#entries.length === 0) return null;
    if (this.#index === -1) {
      this.#index = 0;
      return this.#entries[0] ?? null;
    }
    if (this.#index < this.#entries.length - 1) {
      this.#index++;
      return this.#entries[this.#index] ?? null;
    }
    return this.#entries[this.#index] ?? null;
  }

  next(): string | null {
    if (this.#index <= 0) {
      this.#index = -1;
      return null;
    }
    this.#index--;
    return this.#entries[this.#index] ?? null;
  }
}

// =============================================================================
// Autocomplete logic
// =============================================================================

function fuzzyMatch(query: string, entry: CommandEntry): number {
  const nameLower = entry.name.toLowerCase();
  const descLower = entry.description.toLowerCase();
  const keywordsLower = entry.hiddenKeywords.toLowerCase();
  const searchTarget = `${nameLower} ${descLower} ${keywordsLower}`;
  const queryLower = query.toLowerCase();

  // Exact prefix match on command name — highest priority
  if (nameLower.startsWith(queryLower)) return 100;

  // Substring match on name
  if (nameLower.includes(queryLower)) return 80;

  // Word match on description/keywords
  const words = searchTarget.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(queryLower)) return 60;
    if (word.includes(queryLower)) return 40;
  }

  return 0;
}

function getCompletions(
  query: string,
  skills?: { name: string; description: string }[],
  commands?: CommandEntry[],
): CommandEntry[] {
  const allCommands = [
    ...(commands ?? SLASH_COMMANDS),
    ...buildSkillCommands(skills ?? []),
  ];

  if (!query || query.length < 2) return [];

  const scored = allCommands
    .map((entry) => ({ entry, score: fuzzyMatch(query, entry) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return scored.map(({ entry }) => entry);
}

// =============================================================================
// Component
// =============================================================================

export const ChatInput: React.FC<ChatInputProps> = ({
  phase,
  inputMode,
  onModeChange,
  onSubmit,
  skills,
  commands,
}) => {
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [completionIdx, setCompletionIdx] = useState(0);
  // Track the last input timestamp to detect IME composition
  const lastInputTimeRef = useRef(0);

  const historyRef = useRef(new InputHistory());
  const glyphs = getGlyphs();
  const isBusy = phase === "running" || phase === "blocked";

  // ---------------------------------------------------------------------------
  // (Git branch + cwd display moved to StatusBar)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Extract the current slash-command query from the input text
  // ---------------------------------------------------------------------------
  const slashQuery = useMemo(() => {
    // Only consider text before the first space and cursor
    const beforeCursor = value.slice(0, cursorPos);
    const firstSpace = beforeCursor.indexOf(" ");
    const query = firstSpace > 0 ? beforeCursor.slice(0, firstSpace) : beforeCursor;
    if (!query.startsWith("/") || query.length < 2) return null;
    return query;
  }, [value, cursorPos]);

  // Compute completions
  const completions = useMemo(() => {
    if (!slashQuery) return [];
    return getCompletions(slashQuery, skills, commands);
  }, [slashQuery, skills, commands]);

  // Auto-show completions when there are matches
  const showCompletions = completions.length > 0;

  // Reset completion index when completions change
  useEffect(() => {
    setCompletionIdx(0);
  }, [slashQuery]);

  // ---------------------------------------------------------------------------
  // Key handling
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    // When busy, only allow Ctrl+C
    if (isBusy && input !== "\x03") return;

    // Filter SGR mouse escape sequences — they're handled by the global
    // scroll handler and shouldn't be typed as text.  We intentionally do
    // NOT filter arrow-key sequences (\x1b[A etc.) because they're needed
    // for input history navigation below.
    if (input.startsWith("\x1b[<")) return;

    // Some terminals send mouse wheel events as empty input + the arrow-key
    // flag.  Ignore these in ChatInput — the global handler routes them to
    // message scrolling.
    if (input === "" && (key.upArrow || key.downArrow)) return;

    // Prevent PageUp/PageDown/Home/End escape sequences from leaking as
    // typed text.  These are handled globally (scroll) or via shortcuts.
    if (key.pageUp || key.pageDown || key.home || key.end) return;

    // Handle completion popup navigation (only when popup is visible)
    if (showCompletions) {
      if (key.upArrow) {
        setCompletionIdx((prev) =>
          prev <= 0 ? completions.length - 1 : prev - 1
        );
        return;
      }
      if (key.downArrow || (key.tab && !key.shift)) {
        setCompletionIdx((prev) =>
          prev >= completions.length - 1 ? 0 : prev + 1
        );
        return;
      }
      if (key.return && !key.shift) {
        // If the input already exactly matches a command, submit directly
        // instead of re-accepting the completion (which would loop forever).
        const inputMatchesCommand = completions.some(
          (c) => c.name === value.trim(),
        );
        if (inputMatchesCommand) {
          // Fall through to the normal submit logic below.
        } else {
          // Accept the selected completion into the input
          const selected = completions[completionIdx];
          if (selected) {
            const newValue = selected.name + (selected.argumentHint ? " " : "") + value.slice(cursorPos);
            setValue(newValue);
            setCursorPos(selected.name.length + (selected.argumentHint ? 1 : 0));
          }
          return;
        }
      }
      if (key.escape) {
        // Dismiss completions by clearing value (user can retype)
        // Or just continue to let them type
        return;
      }
    }

    // Shift+Tab — cycle through input modes
    if (key.shift && key.tab) {
      const modes: InputMode[] = ["normal", "shell", "shell_incognito"];
      const idx = modes.indexOf(inputMode);
      onModeChange(modes[(idx + 1) % modes.length]);
      return;
    }

    // Enter — submit (with IME guard: don't submit if input happened within 50ms)
    if (key.return && !key.shift) {
      const timeSinceLastInput = Date.now() - lastInputTimeRef.current;
      // If a character was just typed (IME confirmation), skip this Enter
      if (timeSinceLastInput < 80) {
        return;
      }
      if (value.trim()) {
        // Detect mode from prefix
        const [detectedMode, strippedValue] = detectModePrefix(value);

        if (detectedMode !== "normal" && strippedValue === "") {
          // Just the mode prefix — switch mode
          onModeChange(detectedMode as InputMode);
          setValue("");
          setCursorPos(0);
          return;
        }

        const finalMode = detectedMode !== "normal" ? detectedMode as InputMode : inputMode;
        const finalText = finalMode === inputMode ? value.trim() : strippedValue.trim();

        if (finalText) {
          historyRef.current.add(value);
          onSubmit(finalText, finalMode);
          setValue("");
          setCursorPos(0);
        }
      }
      return;
    }

    // Up arrow — history previous (only on empty line or at start)
    if (key.upArrow && cursorPos === 0) {
      const prev = historyRef.current.previous(value);
      if (prev !== null) {
        setValue(prev);
        setCursorPos(prev.length);
      }
      return;
    }

    // Down arrow — history next
    if (key.downArrow && cursorPos === value.length) {
      const next = historyRef.current.next();
      setValue(next ?? "");
      setCursorPos(next?.length ?? 0);
      return;
    }

    // Tab — cycle completions or auto-complete to first match
    if (key.tab && showCompletions && completions.length > 0) {
      const selected = completions[completionIdx];
      if (selected) {
        const newValue = selected.name;
        setValue(newValue);
        setCursorPos(newValue.length);
      }
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        const before = value.slice(0, cursorPos);
        const after = value.slice(cursorPos);
        // Handle multi-byte characters (CJK, emoji)
        const charLen = [...before.slice(-1)][0]?.length ?? 1;
        setValue(before.slice(0, -charLen) + after);
        setCursorPos(Math.max(0, cursorPos - charLen));
      }
      lastInputTimeRef.current = 0; // Reset IME guard on delete
      return;
    }

    // Left / Right arrow
    if (key.leftArrow) {
      setCursorPos((prev) => {
        if (prev <= 0) return 0;
        // Move left by one grapheme
        const chars = [...value.slice(0, prev)];
        const lastChar = chars[chars.length - 1];
        return prev - (lastChar?.length ?? 1);
      });
      return;
    }
    if (key.rightArrow) {
      setCursorPos((prev) => {
        if (prev >= value.length) return value.length;
        // Move right by one grapheme
        const chars = [...value.slice(prev)];
        const firstChar = chars[0];
        return prev + (firstChar?.length ?? 1);
      });
      return;
    }

    // Ctrl+A / Ctrl+E — home / end
    if (input === "\x01") { setCursorPos(0); return; }
    if (input === "\x05") { setCursorPos(value.length); return; }

    // Ctrl+W — delete word backwards
    if (input === "\x17") {
      const before = value.slice(0, cursorPos);
      const after = value.slice(cursorPos);
      const words = before.split(/(\s+)/);
      words.pop(); // Remove last word/space
      const newBefore = words.join("");
      setValue(newBefore + after);
      setCursorPos(newBefore.length);
      return;
    }

    // ! at start of empty line — toggle shell mode
    if (value.length === 0 && input === "!") {
      onModeChange(inputMode === "shell" ? "normal" : "shell");
      return;
    }

    // ! at start with another ! → toggle incognito shell
    if (value === "!" && input === "!") {
      onModeChange("shell_incognito");
      setValue("");
      setCursorPos(0);
      return;
    }

    // Append typed character (filter pure control chars < 32 except \t, \n, \r)
    // Allow ALL printable Unicode including CJK, emoji, etc.
    if (input) {
      const filtered = [...input].filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 32 || code === 9; // Allow tab, filter other controls
      }).join("");
      if (filtered) {
        setValue((prev) => prev.slice(0, cursorPos) + filtered + prev.slice(cursorPos));
        setCursorPos((prev) => prev + [...filtered].length);
        lastInputTimeRef.current = Date.now();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  // Prompt glyph — ">" in blue (primary), recolors per mode
  const promptGlyph = isBusy ? glyphs.dashed : ">";
  const promptColor = isBusy ? COLORS.muted
    : inputMode === "shell" || inputMode === "shell_incognito" ? COLORS.error
    : COLORS.primary;
  const borderColor = isBusy ? COLORS.muted
    : inputMode === "shell" || inputMode === "shell_incognito" ? COLORS.error
    : COLORS.primary;
  const modeGlyph = MODE_DISPLAY_GLYPHS[inputMode] ?? "";

  // Split value at cursor for rendering
  const beforeCursor = [...value.slice(0, cursorPos)].join("");
  const atCursor = [...value].slice(cursorPos, cursorPos + 1).join("") || " ";
  const afterCursor = [...value].slice(cursorPos + 1).join("");

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Completion popup — auto-shown when matching slash commands */}
      {showCompletions && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={COLORS.primary}
          paddingX={1}
          marginX={1}
          marginBottom={0}
        >
          {completions.map((entry, i) => {
            const isSelected = i === completionIdx;
            return (
              <Box key={entry.name}>
                <Text color={isSelected ? COLORS.primary : undefined} bold={isSelected}>
                  {isSelected ? `${">"} ` : "  "}
                  {entry.name}
                </Text>
                <Text dimColor> — {entry.description}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Input — solid border box with > prompt glyph */}
      <Box
        flexDirection="row"
        borderStyle="single"
        borderColor={borderColor}
        paddingX={1}
      >
        {/* Prompt glyph */}
        <Text bold color={promptColor}>{promptGlyph}</Text>
        <Text> </Text>

        {/* Mode glyph */}
        {modeGlyph && (
          <Text color={COLORS.warning}>{modeGlyph} </Text>
        )}

        {/* Input text with cursor */}
        <Box flexDirection="row" flexGrow={1}>
          {/* Before cursor */}
          <Text>{beforeCursor}</Text>

          {/* Cursor */}
          {!isBusy && (
            <Text inverse>{atCursor}</Text>
          )}

          {/* After cursor */}
          <Text>{afterCursor}</Text>
        </Box>

        {/* Queued indicator */}
        {isBusy && value && (
          <Text dimColor> [queued]</Text>
        )}
      </Box>
    </Box>
  );
};
