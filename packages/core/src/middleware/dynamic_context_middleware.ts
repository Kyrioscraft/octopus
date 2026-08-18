/**
 * Dynamic-context middleware — injects `<system-reminder>` blocks into the
 * latest user message, mirroring ZCode's pattern for prompt-cache-friendly
 * dynamic context delivery.
 *
 * ## Why this exists
 *
 * ZCode keeps the system message *static* (role + behavior conventions only)
 * and delivers all dynamic environment context — current date, working
 * directory, model identity, access mode, available skills — as
 * `<system-reminder>` blocks prepended to the most recent user message.
 * Benefits:
 *
 * 1. **Prompt-cache stability** — the system message is byte-identical across
 *    turns, so Anthropic prompt caching hits on every call. When dynamic
 *    context lives in the system message, any change invalidates the cache.
 * 2. **Per-turn freshness** — date, mode, and environment can change between
 *    turns without rebuilding the graph or rewriting the system prompt.
 * 3. **Source clarity** — the `<system-reminder>` tag is explicitly marked as
 *    harness-injected (not user-authored), so the model distinguishes
 *    environment context from user intent.
 *
 * ## What it does
 *
 * On every `wrapModelCall`, finds the last `HumanMessage` in `request.messages`
 * and prepends one or more `<system-reminder>` blocks to its content:
 *
 * - Environment block: cwd, platform, git status, model identity, access mode
 * - Date line (current date, computed fresh each call)
 * - Mode-specific guidance (plan = read-only; full = autonomous; etc.)
 * - Output-format reminder (terminal plain-text vs headless)
 * - Skills path (if any)
 *
 * ## Idempotency
 *
 * The same HumanMessage is seen across multiple model calls within one turn
 * (e.g. tool-call → tool-result → next model call). To avoid stacking
 * reminders, each injected block carries a `data-source="dynamic-context"`
 * attribute. Before injecting, we check for this sentinel; if present, the
 * message is returned unchanged.
 *
 * ## Message-format handling
 *
 * `HumanMessage.content` may be a `string` or `Array<ContentBlock>`. Both are
 * handled (see `readMessageText` / `withMessageContent` below), mirroring the
 * `system_message_utils.ts` helpers but applied to non-system messages.
 *
 * ## Placement in the middleware stack
 *
 * Pushed AFTER `SubagentOrchestrationMiddleware` in agent.ts. It only mutates
 * `request.messages` (not `systemMessage`), so it does not conflict with
 * middlewares that rewrite the system message. Placed late so the reminder is
 * the last thing injected into the user message before the model sees it.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../logging.js";


const logger = getLogger("middleware.dynamic_context");

// =============================================================================
// Types
// =============================================================================

export interface SkillSummary {
  name: string;
  description: string;
}

export interface DynamicContextOptions {
  /** Working directory the agent operates in. */
  cwd: string;
  /** Model identifier (e.g. `claude-sonnet-4-6`). */
  modelName?: string;
  /** Provider identifier (e.g. `anthropic`). */
  provider?: string;
  /** Whether the agent runs in interactive (HITL) mode. */
  interactive: boolean;
  /** Primary agent name (successor to accessMode — see agents/builtin.ts). */
  agentName: string;
  /** Mode guidance text from the agent preset (replaces the old switch). */
  promptBlock: string;
  /** Skills directory path(s), comma-joined if multiple. */
  skillsPath?: string;
  /** Available skills (name + one-line description) for the skills reminder. */
  skills?: SkillSummary[];
}

// =============================================================================
// Git snapshot (fetched once at graph build time, ZCode-style)
// =============================================================================

interface GitSnapshot {
  branch?: string;
  /** Porcelain status lines, capped at 10. */
  status: string[];
  isRepo: boolean;
}

/**
 * Capture a one-time git snapshot of the working directory. Executed in the
 * middleware constructor (graph build time), NOT on every model call — a
 * per-call `execSync` would add latency and the branch rarely matters enough
 * to need second-level freshness (ZCode takes the same snapshot approach).
 */
function _captureGitSnapshot(cwd: string): GitSnapshot {
  const opts: ExecSyncOptions = {
    cwd,
    timeout: 3000,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).toString().trim();
    const raw = execSync("git status --porcelain", opts).toString();
    const status = raw.split("\n").filter((l) => l.trim().length > 0);
    return { branch, status, isRepo: true };
  } catch {
    return { status: [], isRepo: false };
  }
}

/** Cap on status lines included in the reminder. */
const GIT_STATUS_CAP = 10;

// =============================================================================
// Message-content helpers (mirror system_message_utils.ts for non-system msgs)
// =============================================================================

/**
 * Read the full text of any BaseMessage, regardless of whether `content` is a
 * string or a content-blocks array. Uses the official `.text` getter when
 * available; falls back to manual extraction.
 */
function readMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { text?: unknown; content?: unknown };

  if (typeof msg.text === "string") return msg.text;

  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "type" in b && (b as any).type === "text") {
          return (b as { text?: string }).text ?? "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Rebuild a message with new content, preserving the original message's
 * prototype and metadata. Content is written as a plain string for the
 * string-input path, or as a content-blocks array if the caller passes one.
 */
function withMessageContent<T>(message: T, newContent: string | Array<{ type: string; text: string }>): T {
  if (!message || typeof message !== "object") return message;
  return Object.assign(
    Object.create(Object.getPrototypeOf(message)),
    message,
    { content: newContent },
  ) as T;
}

// =============================================================================
// Human-message detection
// =============================================================================

function _isHumanMessage(msg: BaseMessage): boolean {
  return (
    (msg as any).type === "human" ||
    (msg as any)._getType?.() === "human"
  );
}

/**
 * Find the index of the last HumanMessage in the array. Returns -1 if none.
 * Uses a manual reverse scan for broad Node version compatibility
 * (`Array.findLastIndex` requires Node 18+; the manual loop is universally
 * safe and trivially cheap).
 */
function _findLastHumanIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (_isHumanMessage(messages[i])) return i;
  }
  return -1;
}

// =============================================================================
// system-reminder block builders
// =============================================================================

/**
 * Sentinel attribute marking reminder blocks injected by THIS middleware.
 * Distinguishes them from SDK/other-source `<system-reminder>` blocks so we
 * don't mis-detect foreign blocks during the idempotency check.
 */
const REMINDER_SENTINEL = `<system-reminder data-source="dynamic-context">`;

/**
 * Compute today's date as YYYY-MM-DD. Computed fresh on every call so the
 * reminder stays correct across long-lived sessions and midnight boundaries.
 */
function _today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the environment-info reminder block. Mirrors ZCode's structure:
 * working directory, platform, git snapshot, model identity, access mode.
 */
function _buildEnvironmentBlock(opts: DynamicContextOptions, git: GitSnapshot): string {
  const lines: string[] = [
    "# Environment",
    `- Primary working directory: ${opts.cwd}`,
    `- Platform: ${process.platform}`,
  ];
  if (git.isRepo) {
    lines.push(`- Is a git repository: yes`);
    if (git.branch) lines.push(`- Current branch: ${git.branch}`);
    if (git.status.length > 0) {
      const shown = git.status.slice(0, GIT_STATUS_CAP);
      lines.push(`- Modified files (${git.status.length}):`);
      for (const line of shown) lines.push(`  ${line}`);
      if (git.status.length > shown.length) {
        lines.push(`  … and ${git.status.length - shown.length} more (run git status to see all)`);
      }
    } else {
      lines.push(`- Working tree: clean`);
    }
  } else {
    lines.push(`- Is a git repository: no`);
  }
  if (opts.modelName) {
    const modelPart = opts.provider
      ? `${opts.modelName} (provider: ${opts.provider})`
      : opts.modelName;
    lines.push(`- Model: ${modelPart}`);
  }
  lines.push(`- Agent: ${opts.agentName}`);
  return `<system-reminder data-source="dynamic-context">\n${lines.join("\n")}\n\nCurrent date: ${_today()}\n</system-reminder>`;
}

/**
 * Build the mode-specific guidance reminder. Keeps behavior that depends on
 * the active agent out of the static system prompt. The guidance text comes
 * verbatim from the agent preset (agents/builtin.ts) — this used to be a
 * switch over AccessMode before the agent migration (phase 1).
 */
function _buildModeBlock(opts: DynamicContextOptions): string {
  return `<system-reminder data-source="dynamic-context">\n${opts.promptBlock}\n</system-reminder>`;
}

/**
 * Build the output-format reminder. The terminal/plain-text constraint is an
 * environment property, not a static behavior rule — belongs here, not in the
 * system message.
 */
function _buildOutputFormatBlock(opts: DynamicContextOptions): string {
  const text = opts.interactive
    ? "Your responses are displayed in a terminal as PLAIN TEXT. Do NOT use " +
      "markdown formatting — no #, **, *, `, ```code fences```, tables (|), or " +
      "markdown lists. Write in plain readable text using indentation and line " +
      "breaks for structure. For code, indent with spaces — do not wrap in " +
      "backtick fences."
    : "You are running in non-interactive (headless) mode. There is no human " +
      "monitoring in real time — complete the task autonomously without asking " +
      "for clarification. Use non-interactive command variants (npm init -y, " +
      "apt-get install -y, --no-input flags). Never block on stdin.";
  return `<system-reminder data-source="dynamic-context">\n${text}\n</system-reminder>`;
}

/** Cap on skills listed in the reminder. */
const SKILLS_CAP = 15;

/**
 * Skills reminder. Lists each skill's name and one-line description (ZCode
 * style) so the model knows WHEN to reach for a skill — a bare path does not.
 * Falls back to the path-only form when no skill summaries are available.
 */
function _buildSkillsBlock(opts: DynamicContextOptions): string | null {
  if (opts.skills && opts.skills.length > 0) {
    const shown = opts.skills.slice(0, SKILLS_CAP);
    const lines = shown.map((s) => `- ${s.name}: ${s.description}`);
    if (opts.skills.length > shown.length) {
      lines.push(`… and ${opts.skills.length - shown.length} more`);
    }
    const pathNote = opts.skillsPath ? `\nStored at: \`${opts.skillsPath}\`` : "";
    return `<system-reminder data-source="dynamic-context">\n# Available skills\n${lines.join("\n")}${pathNote}\n</system-reminder>`;
  }
  if (!opts.skillsPath) return null;
  return `<system-reminder data-source="dynamic-context">\nYour skills are stored at: \`${opts.skillsPath}\`. Skills may contain scripts or supporting files. When executing skill scripts with bash, use the real filesystem path.\n</system-reminder>`;
}

/** Cap on AGENTS.md content included in the reminder. */
const AGENTS_MD_CAP = 4000;

/**
 * Project-instructions reminder. If the project has an AGENTS.md (or
 * CLAUDE.md fallback), its content is project-specific guidance that belongs
 * in the conversation context, not baked into the static system prompt
 * (which must stay cache-stable across projects when a shared server serves
 * many workspaces).
 */
function _buildProjectInstructionsBlock(cwd: string): string | null {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const name of candidates) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8").trim();
      if (!content) continue;
      const truncated =
        content.length > AGENTS_MD_CAP
          ? content.slice(0, AGENTS_MD_CAP) + "\n… (truncated)"
          : content;
      return `<system-reminder data-source="dynamic-context">\n# Project instructions (${name})\n\n${truncated}\n</system-reminder>`;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Assemble all reminder blocks into a single prefix string, separated by
 * blank lines. This is what gets prepended to the user message content.
 */
function buildSystemReminder(opts: DynamicContextOptions, git: GitSnapshot): string {
  const blocks: string[] = [
    _buildEnvironmentBlock(opts, git),
    _buildModeBlock(opts),
    _buildOutputFormatBlock(opts),
  ];
  const skills = _buildSkillsBlock(opts);
  if (skills) blocks.push(skills);
  const project = _buildProjectInstructionsBlock(opts.cwd);
  if (project) blocks.push(project);
  return blocks.join("\n\n");
}

// =============================================================================
// Message rewriting
// =============================================================================

/**
 * Prepend the reminder text to a message, handling both string and array
 * content formats. Returns the original message object (re-typed) if the
 * content format is unrecognized.
 */
function _injectReminder<T extends BaseMessage>(
  message: T,
  reminder: string,
): T {
  const content = (message as any).content;

  // String content — simple concatenation.
  if (typeof content === "string") {
    const newContent = content.length > 0
      ? `${reminder}\n\n${content}`
      : reminder;
    return withMessageContent(message, newContent);
  }

  // Array content — prepend a text block.
  if (Array.isArray(content)) {
    const newContent: Array<{ type: string; text: string }> = [
      { type: "text", text: reminder },
      ...content.filter(
        (b: unknown) =>
          b && typeof b === "object" && "type" in (b as any),
      ),
    ];
    return withMessageContent(message, newContent);
  }

  // Unrecognized format — leave unchanged rather than risk corrupting it.
  logger.warn("HumanMessage has unrecognized content format; skipping reminder injection");
  return message;
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Injects dynamic environment context as `<system-reminder>` blocks into the
 * latest user message on every model call. See file header for full rationale.
 *
 * Constructor takes a snapshot of the agent's environment (cwd, model, mode).
 * The date is recomputed fresh each call; other fields reflect the graph's
 * configuration (which is fine — graph rebuild on config change is the
 * existing contract).
 */
class DynamicContextMiddleware {
  name = "DynamicContextMiddleware";

  /** One-time git snapshot (branch + status) captured at graph build. */
  private readonly git: GitSnapshot;

  constructor(private readonly opts: DynamicContextOptions) {
    this.git = _captureGitSnapshot(opts.cwd);
    if (this.git.isRepo) {
      logger.debug(
        `Git snapshot: branch=${this.git.branch}, modified=${this.git.status.length}`,
      );
    }
  }

  wrapModelCall = (
    request: {
      tools?: any[];
      messages?: BaseMessage[];
      systemMessage?: any;
      [key: string]: unknown;
    },
    handler: (req: any) => any,
  ): any => {
    const messages = request.messages;
    if (!messages || messages.length === 0) {
      return handler(request);
    }

    const lastHumanIdx = _findLastHumanIndex(messages);
    if (lastHumanIdx === -1) {
      return handler(request);
    }

    const target = messages[lastHumanIdx];

    // Idempotency: skip if this message already carries our sentinel.
    // The same HumanMessage is seen across multiple model calls within one
    // turn (tool-call → result → next call); without this check the reminder
    // would stack on every iteration.
    const existingText = readMessageText(target);
    if (existingText.includes(REMINDER_SENTINEL)) {
      return handler(request);
    }

    const reminder = buildSystemReminder(this.opts, this.git);
    const rewritten = _injectReminder(target, reminder);

    const newMessages = [...messages];
    newMessages[lastHumanIdx] = rewritten;

    logger.debug(
      `Injected system-reminder into HumanMessage at index ${lastHumanIdx} ` +
        `(cwd=${this.opts.cwd}, agent=${this.opts.agentName})`,
    );

    return handler({ ...request, messages: newMessages });
  };
}

export { DynamicContextMiddleware };
