/**
 * System prompt generation for the agent.
 *
 * Equivalent to Python `cortex.agent.get_system_prompt()` +
 * `cortex.agent.build_model_identity_section()`.
 */

import { getLogger } from "./logging.js";

const logger = getLogger("prompts");

// =============================================================================
// System prompt template — inlined from system_prompt.md.
// =============================================================================

const SYSTEM_PROMPT_TEMPLATE = `# Deep Agents Code

You are a deep agent, an AI assistant that helps with software engineering tasks: coding, debugging, research, and analysis.

# Harness

- Text you output outside of tool use is displayed to the user as GitHub-flavored markdown.
- \`<system-reminder>\` tags in user messages are injected by the harness, not the user. They carry environment information (date, working directory, access mode, skills) — read them before acting.
- Prefer the dedicated file tools (read_file / edit_file / write_file) over shell commands for file operations. Independent tool calls can run in parallel in one response.
- Reference code as \`file_path:line_number\` — it is clickable.
- Write code that reads like the surrounding code: match its comment density, naming, and idiom.
- All file paths must be absolute — construct them from the working directory in the \`<system-reminder>\`.

# Conduct

- Be concise and direct. Answer in fewer than 4 lines unless detail is requested. No time estimates.
- Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly.
- For actions that are hard to reverse or outward-facing, confirm first unless durably authorized. Never commit or push unless the user explicitly asks; never commit secrets.
- Only make changes that are directly requested — do not add features, refactor, or improve code beyond what was asked. Never add comments unless asked.
- Before deleting or overwriting, look at the target — if what you find contradicts how it was described, surface that instead of proceeding.
- When a tool call is rejected by the user, accept it immediately — do not retry the same call; suggest an alternative or ask for clarification.
- If you notice yourself going in circles (3+ failed attempts with the same approach), stop and ask the user.

Here are examples that demonstrate appropriate verbosity:

<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>

<example>
user: what command should I run to list files in the current directory?
assistant: ls
</example>

<example>
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>
{ambiguity_guidance}
`;

// =============================================================================
// buildModelIdentitySection — from Python `agent.py:build_model_identity_section`.
// =============================================================================

/**
 * Build the `### Model Identity` section for the system prompt.
 *
 * @param name         Model identifier (e.g. `claude-opus-4-6`).
 * @param provider     Provider identifier (e.g. `anthropic`).
 * @param contextLimit Max input tokens from the model profile.
 * @param unsupportedModalities Input modalities not indicated as supported.
 *
 * @returns The section text including heading and trailing newline,
 *          or empty string if `name` is falsy.
 *
 * Equivalent to Python `build_model_identity_section()`.
 */
export function buildModelIdentitySection(
  name: string | undefined,
  provider?: string,
  contextLimit?: number | null,
  unsupportedModalities?: ReadonlySet<string>,
): string {
  if (!name) return "";

  let section = `### Model Identity\n\nYou are running as model \`${name}\``;
  if (provider) {
    section += ` (provider: ${provider})`;
  }
  section += ".\n";

  if (contextLimit) {
    section += `Your context window is ${contextLimit.toLocaleString()} tokens.\n`;
  }

  if (unsupportedModalities && unsupportedModalities.size > 0) {
    const items = [...unsupportedModalities].sort();
    let joined: string;
    if (items.length === 1) {
      joined = items[0];
    } else if (items.length === 2) {
      joined = `${items[0]} and ${items[1]}`;
    } else {
      joined = items.slice(0, -1).join(", ") + `, and ${items[items.length - 1]}`;
    }
    section +=
      `${joined.charAt(0).toUpperCase() + joined.slice(1)} input may not be available for this model. ` +
      "Do not attempt to read or process these content types.\n";
  }

  section += "\n";
  return section;
}

// =============================================================================
// getSystemPrompt — from Python `agent.py:get_system_prompt`.
// =============================================================================

export interface SystemPromptOptions {
  /** Agent identifier (kept for API stability; no longer used in the static template). */
  assistantId: string;

  /** Whether the agent is running in interactive (HITL) mode. */
  interactive?: boolean;
}

/**
 * Generate the full system prompt from the template.
 *
 * The system prompt is now **static** — it contains only role, behavior, and
 * convention guidance that never changes across turns. Dynamic environment
 * context (working directory, model identity, access mode, current date,
 * output-format constraints, skills path) is delivered via `<system-reminder>`
 * blocks injected into the latest user message by `DynamicContextMiddleware`
 * (see middleware/dynamic_context_middleware.ts). This split maximizes
 * Anthropic prompt-cache stability.
 *
 * The only remaining interpolation is `ambiguity_guidance` and `todo_guidance`,
 * which differ between interactive and headless modes — these reflect a static
 * property of the agent's deployment, not per-turn state, so they stay here.
 *
 * Equivalent to Python `get_system_prompt()`.
 */
export function getSystemPrompt(options: SystemPromptOptions): string {
  const { interactive = true } = options;

  const template = SYSTEM_PROMPT_TEMPLATE;

  // -- Mode-specific guidance (interactive vs headless) --
  // These reflect a STATIC deployment property (the agent is either always
  // interactive or always headless for its lifetime), so they belong in the
  // system prompt. Per-turn dynamic context (date, cwd, mode, model) lives in
  // the <system-reminder> injected by DynamicContextMiddleware.
  let ambiguityGuidance: string;

  if (interactive) {
    ambiguityGuidance =
      "- If the request is ambiguous, ask questions before acting.\n" +
      "- If asked how to approach something, explain first, then act.\n" +
      "- When you need the user to choose between approaches, technologies, or\n" +
      "  design options, or to resolve a materially ambiguous requirement, call\n" +
      "  the `ask_user_question` tool to present the choice — do NOT just list\n" +
      "  options as plain text.\n" +
      "- Prefer `ask_user_question` over guessing whenever the user's preference\n" +
      "  would change what you build (target stack, scope, data format, etc.).";
  } else {
    ambiguityGuidance =
      "- Do NOT ask clarifying questions — there is no human to answer " +
      "them. Make reasonable assumptions and proceed.\n" +
      "- If you encounter ambiguity, choose the most reasonable " +
      "interpretation and note your assumption briefly.\n" +
      "- Always use non-interactive command variants — no human is " +
      "available to respond to prompts. Examples: `npm init -y` not " +
      "`npm init`, `apt-get install -y` not `apt-get install`, " +
      "`yes |` or `--no-input`/`--non-interactive` flags where " +
      "available. Never run commands that block waiting for stdin.";
  }

  // -- Template interpolation --
  let result = template.replace(/\{ambiguity_guidance\}/g, ambiguityGuidance);

  // Detect unreplaced placeholders (defense-in-depth for template typos)
  const unreplaced = result.match(/\{[a-z_]+\}/g);
  if (unreplaced && unreplaced.length > 0) {
    logger.warn(
      `System prompt contains unreplaced placeholders: ${unreplaced.join(", ")}`,
    );
  }

  return result;
}
