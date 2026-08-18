/**
 * Helpers for reading and rewriting the agent's system message across the
 * string-content and content-block-array formats used by @langchain/core v1.
 *
 * Background — why these helpers exist:
 *
 * `deepagents` constructs the initial `SystemMessage` with `contentBlocks: [...]`
 * (an array of `{type:"text",text}` blocks), never a plain string. The
 * `@langchain/core` `BaseMessage` constructor stores that array directly on
 * `this.content` (base.js:127-128). Every subsequent `systemMessage.concat(str)`
 * in the SDK middleware chain keeps it an array (`mergeContent`, base.js:48-51).
 *
 * So by the time octopus's custom middlewares run, `systemMessage.content` is
 * `Array<ContentBlock>`, NOT a string. Middlewares that guarded on
 * `typeof content === "string"` silently skipped all their logic.
 *
 * These helpers use the official `BaseMessage.text` getter (base.js:144-152),
 * which flattens both string and array forms into a single string. This is the
 * langchain public API designed for exactly this purpose.
 */

/**
 * Read the full text of a system message, regardless of whether `content` is a
 * string or a content-blocks array. Uses the official `BaseMessage.text` getter
 * when available (handles both formats); falls back to manual extraction for
 * plain objects that lack the getter.
 */
export function readSystemMessageText(systemMessage: unknown): string {
  if (!systemMessage || typeof systemMessage !== "object") return "";
  const msg = systemMessage as { text?: unknown; content?: unknown };

  // Prefer the official .text getter — it normalizes string | ContentBlock[].
  // (base.js:144-152: string → as-is; array → join of text blocks.)
  if (typeof msg.text === "string") return msg.text;

  // Fallback: manual extraction.
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "type" in b && b.type === "text") {
          return (b as { text?: string }).text ?? "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Rebuild a system message with new string content, preserving the original
 * message's prototype and metadata (id, name, response_metadata).
 *
 * The content is written as a plain string — the simplest form accepted by
 * `MessageContent = string | Array<ContentBlock>`. octopus middlewares that
 * reach this point exist to *change* the system message text, so any prior
 * Anthropic prompt-cache breakpoint on the modified message is invalidated by
 * design; writing a string is the cleanest post-edit representation.
 */
export function withSystemMessageText<T>(systemMessage: T, newText: string): T {
  if (!systemMessage || typeof systemMessage !== "object") return systemMessage;
  return Object.assign(
    Object.create(Object.getPrototypeOf(systemMessage)),
    systemMessage,
    { content: newText },
  ) as T;
}
