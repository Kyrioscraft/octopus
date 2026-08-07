// =============================================================================
// Global theme constants — Tokyo-night inspired palette.
//
// Color = identity. Each role has a dedicated accent:
//   primary  (blue)    — user messages, prompt glyph, loading spinner
//   tool     (amber)   — tool calls, running state, manual-approve
//   skill    (purple)  — skill invocations, command mode
//   error    (pink)    — errors, shell mode
//   success  (green)   — success, auto-approve
//   incognito (teal)   — incognito shell mode
//   muted    (gray)    — secondary text, timestamps, hints
// =============================================================================

/** Semantic color roles used across the TUI. */
export const COLORS = {
  /** Primary accent — blue. User messages, prompt, loading. */
  primary: "#7AA2F7",
  /** Tool accent — amber. Tool calls, running, manual-approve. */
  tool: "#EB8B46",
  /** Tool hover — lighter amber. */
  toolHover: "#FFCB91",
  /** Skill accent — purple. Skill invocations, command mode. */
  skill: "#A78BFA",
  /** Secondary — purple. Command mode borders. */
  secondary: "#BB9AF7",
  /** Error accent — pink. Errors, shell mode. */
  error: "#F7768E",
  /** Success accent — green. Approvals, completed, auto-approve. */
  success: "#9ECE6A",
  /** Warning — amber (alias of tool). */
  warning: "#EB8B46",
  /** Incognito — teal. Incognito shell mode. */
  incognito: "#2AC4BF",
  /** Muted — gray. Secondary text. */
  muted: "gray",
  /** Body text — light blue-white. */
  body: "#C0CAF5",
  // Legacy aliases (for backward compat with existing code)
  user: "#7AA2F7",
  assistant: "#C0CAF5",
  reasoning: "gray",
  accent: "#7AA2F7",
  accentSecondary: "#EB8B46",
} as const;

/** Border styles keyed by semantic role (maps to Ink's borderStyle prop). */
export const BORDERS = {
  /** Standard rounded border for modals and panels. */
  panel: "round" as const,
  /** Single-line border for inline boxes / input. */
  box: "single" as const,
  /** Bold border for the active input. */
  input: "single" as const,
};

/** Standard keyboard hint shown at the bottom of selector modals. */
export const NAV_HINT = "↑↓ navigate · Enter select · Esc dismiss";
