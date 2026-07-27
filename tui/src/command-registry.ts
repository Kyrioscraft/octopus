// =============================================================================
// Unified slash-command registry.
//
// Equivalent to Python tui.command_registry.
//
// Every slash command is declared once as a SlashCommand entry in COMMANDS.
// Bypass-tier frozensets and autocomplete entries are derived automatically.
// =============================================================================

// =============================================================================
// Bypass tier — controls whether a command can skip the message queue
// =============================================================================

export enum BypassTier {
  /** Execute regardless of any busy state, including mid-thread-switch. */
  ALWAYS = "always",
  /** Bypass only during initial server connection, not during agent/shell. */
  CONNECTING = "connecting",
  /** Open modal UI immediately; real work deferred via callback. */
  IMMEDIATE_UI = "immediate_ui",
  /** Execute the side effect immediately; defer chat output until idle. */
  SIDE_EFFECT_FREE = "side_effect_free",
  /** Must wait in the queue when the app is busy. */
  QUEUED = "queued",
}

// =============================================================================
// SlashCommand — a single slash-command definition
// =============================================================================

export interface SlashCommand {
  /** Canonical command name (e.g. "/quit"). */
  name: string;
  /** Short user-facing description. */
  description: string;
  /** Queue-bypass classification. */
  bypassTier: BypassTier;
  /** Space-separated terms for fuzzy matching (never displayed). */
  hiddenKeywords?: string;
  /** Placeholder text for autocomplete when the command accepts args. */
  argumentHint?: string;
  /** Alternative names (e.g. ["/q"] for "/quit"). */
  aliases?: readonly string[];
}

// =============================================================================
// CommandEntry — lightweight autocomplete entry
// =============================================================================

export interface CommandEntry {
  /** Canonical command name (e.g. "/quit"). */
  name: string;
  /** Short user-facing description. */
  description: string;
  /** Space-separated terms for fuzzy matching (never displayed). */
  hiddenKeywords: string;
  /** Placeholder text shown when the command accepts arguments. */
  argumentHint: string;
}

// =============================================================================
// All slash commands — single source of truth
// =============================================================================

export const COMMANDS: readonly SlashCommand[] = [
  {
    name: "/agents",
    description: "Browse and switch between available agents",
    bypassTier: BypassTier.IMMEDIATE_UI,
    hiddenKeywords: "switch profile persona",
  },
  {
    name: "/auth",
    description: "Manage stored API keys for model providers",
    bypassTier: BypassTier.IMMEDIATE_UI,
    hiddenKeywords: "key keys credential credentials login token api",
    aliases: ["/connect"],
  },
  {
    name: "/clear",
    description: "Clear chat and start new thread",
    bypassTier: BypassTier.QUEUED,
    hiddenKeywords: "reset",
  },
  {
    name: "/copy",
    description: "Copy latest assistant message to clipboard",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
  },
  {
    name: "/force-clear",
    description: "Interrupt active work, clear chat, and start new thread",
    bypassTier: BypassTier.ALWAYS,
    hiddenKeywords: "reset interrupt",
  },
  {
    name: "/editor",
    description: "Open prompt in external editor ($EDITOR)",
    bypassTier: BypassTier.QUEUED,
  },
  {
    name: "/mcp",
    description: "Show MCP servers; /mcp login <server> to authenticate, /mcp reconnect to load deferred logins",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
    hiddenKeywords: "servers oauth authenticate reconnect disable enable",
    argumentHint: "[login <server> | reconnect]",
  },
  {
    name: "/model",
    description: "Switch or configure model",
    bypassTier: BypassTier.IMMEDIATE_UI,
  },
  {
    name: "/notifications",
    description: "Configure notification preferences",
    bypassTier: BypassTier.IMMEDIATE_UI,
    hiddenKeywords: "warnings alerts suppress",
  },
  {
    name: "/offload",
    description: "Free up context window space by offloading older messages",
    bypassTier: BypassTier.QUEUED,
    hiddenKeywords: "compact",
    aliases: ["/compact"],
  },
  {
    name: "/remember",
    description: "Update memory and skills from conversation",
    bypassTier: BypassTier.QUEUED,
    argumentHint: "[context]",
  },
  {
    name: "/skill-creator",
    description: "Guide for creating effective agent skills",
    bypassTier: BypassTier.QUEUED,
    argumentHint: "[task]",
  },
  {
    name: "/threads",
    description: "Browse and resume previous threads",
    bypassTier: BypassTier.IMMEDIATE_UI,
    hiddenKeywords: "continue history sessions",
  },
  {
    name: "/trace",
    description: "Open current thread in LangSmith",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
  },
  {
    name: "/tokens",
    description: "Token usage",
    bypassTier: BypassTier.QUEUED,
    hiddenKeywords: "cost",
  },
  {
    name: "/reload",
    description: "Reload config from environment variables and .env",
    bypassTier: BypassTier.QUEUED,
    hiddenKeywords: "refresh",
  },
  {
    name: "/theme",
    description: "Switch color theme",
    bypassTier: BypassTier.IMMEDIATE_UI,
    hiddenKeywords: "dark light color appearance",
  },
  {
    name: "/timestamps",
    description: "Toggle message timestamp footers",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
    hiddenKeywords: "time footer footers date dates",
  },
  {
    name: "/update",
    description: "Check for and install updates",
    bypassTier: BypassTier.QUEUED,
    hiddenKeywords: "upgrade",
  },
  {
    name: "/install",
    description: "Install an optional package or extra",
    bypassTier: BypassTier.QUEUED,
    hiddenKeywords: "extra extras add provider dependency",
    argumentHint: "<extra>",
  },
  {
    name: "/auto-update",
    description: "Toggle automatic updates on or off",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
  },
  {
    name: "/changelog",
    description: "Open changelog in browser",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
  },
  {
    name: "/version",
    description: "Show version",
    bypassTier: BypassTier.CONNECTING,
    aliases: ["/about"],
  },
  {
    name: "/feedback",
    description: "Submit a bug report or feature request",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
  },
  {
    name: "/docs",
    description: "Open documentation in browser",
    bypassTier: BypassTier.SIDE_EFFECT_FREE,
  },
  {
    name: "/help",
    description: "Show help",
    bypassTier: BypassTier.QUEUED,
  },
  {
    name: "/quit",
    description: "Exit app",
    bypassTier: BypassTier.ALWAYS,
    hiddenKeywords: "close leave",
    aliases: ["/q"],
  },
];

// =============================================================================
// Derived bypass-tier sets
// =============================================================================

function buildBypassSet(tier: BypassTier): Set<string> {
  const names = new Set<string>();
  for (const cmd of COMMANDS) {
    if (cmd.bypassTier === tier) {
      names.add(cmd.name);
      for (const alias of cmd.aliases ?? []) {
        names.add(alias);
      }
    }
  }
  return names;
}

/** Commands that execute regardless of any busy state. */
export const ALWAYS_IMMEDIATE: ReadonlySet<string> = buildBypassSet(BypassTier.ALWAYS);

/** Commands that bypass only during initial server connection. */
export const BYPASS_WHEN_CONNECTING: ReadonlySet<string> = buildBypassSet(BypassTier.CONNECTING);

/** Commands that open modal UI immediately, deferring real work. */
export const IMMEDIATE_UI: ReadonlySet<string> = buildBypassSet(BypassTier.IMMEDIATE_UI);

/** Commands whose side effect fires immediately; chat output deferred until idle. */
export const SIDE_EFFECT_FREE: ReadonlySet<string> = buildBypassSet(BypassTier.SIDE_EFFECT_FREE);

/** Commands that must wait in the queue when the app is busy. */
export const QUEUE_BOUND: ReadonlySet<string> = buildBypassSet(BypassTier.QUEUED);

/** Power-user commands kept out of autocomplete and help. */
export const HIDDEN_COMMANDS: ReadonlySet<string> = new Set(["/debug-error", "/restart"]);

/** QUEUED-tier commands that must still run when startup has failed. */
export const STARTUP_RECOVERY_COMMANDS: ReadonlySet<string> = new Set([
  "/install",
  "/reload",
  "/update",
]);

// =============================================================================
// Autocomplete entries
// =============================================================================

function toEntry(cmd: SlashCommand): CommandEntry {
  return {
    name: cmd.name,
    description: cmd.description,
    hiddenKeywords: cmd.hiddenKeywords ?? "",
    argumentHint: cmd.argumentHint ?? "",
  };
}

/** Autocomplete entries derived from COMMANDS. */
export const SLASH_COMMANDS: readonly CommandEntry[] = COMMANDS.map(toEntry);

// =============================================================================
// Skill command helpers
// =============================================================================

const STATIC_SKILL_ALIASES: ReadonlySet<string> = new Set(["remember", "skill-creator"]);

/**
 * Extract skill name and args from a `/skill:<name>` command.
 * Equivalent to Python `parse_skill_command()`.
 */
export function parseSkillCommand(command: string): [string, string] {
  const afterPrefix = command.slice("/skill:".length).trim();
  const parts = afterPrefix.split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    return ["", ""];
  }
  const skillName = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");
  return [skillName, args];
}

/**
 * Build autocomplete entries for discovered skills.
 * Equivalent to Python `build_skill_commands()`.
 */
export function buildSkillCommands(
  skills: { name: string; description: string }[]
): CommandEntry[] {
  return skills
    .filter((skill) => !STATIC_SKILL_ALIASES.has(skill.name))
    .map((skill) => ({
      name: `/skill:${skill.name}`,
      description: skill.description,
      hiddenKeywords: skill.name,
      argumentHint: "",
    }));
}
