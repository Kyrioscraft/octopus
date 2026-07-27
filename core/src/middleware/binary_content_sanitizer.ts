/**
 * Sanitize binary / multimodal content in tool results so they don't crash
 * LangGraph's Rust checkpointer backend.
 *
 * The deepagents SDK's `read_file` tool returns multimodal content blocks for
 * binary files: `{type: "image"|"audio"|"video"|"file", mimeType, data}`. The
 * Python original works because langchain-core treats `FileContentBlock` as a
 * first-class type and providers (Gemini/Anthropic) accept it natively.
 *
 * In this TS port, however, the LangGraph **Rust backend** checkpointer can
 * only deserialize `text` and `image_url` content variants — any other type
 * (`file`, `image`, `audio`, `video`, …) raises a 400 deserialization error
 * as soon as the thread is reloaded. This middleware intercepts tool results
 * *before* they are persisted to state and rewrites unsupported blocks into a
 * text placeholder, mirroring the fallback used by the Python
 * `deepagents.middleware.summarization._media_reference_block` (which renders
 * non-image/audio/video MIMEs as `<file url="…" />`).
 *
 * Placing this in `core` (not `server`) protects every consumer — server HTTP
 * route, TUI, future clients — rather than patching each individually.
 */

import { ToolMessage } from "@langchain/core/messages";

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

/** Content types the LangGraph Rust checkpointer can deserialize. */
const SUPPORTED_CONTENT_TYPES = new Set(["text", "image_url"]);

/** Tools whose results commonly carry binary/multimodal content. */
const BINARY_TOOL_NAMES = new Set(["read_file", "readfile", "read"]);

/**
 * Rewrite a single content part that the Rust backend can't deserialize into
 * a lossy-but-safe text placeholder.
 *
 * Order of preference for extracting a human-readable label from the block:
 *   1. an explicit `source_url` / `url` / `file_path` / `path`
 *   2. a MIME type (e.g. `application/pdf`)
 *   3. the raw block type
 */
function _sanitizeContentPart(part: any): any {
  if (!part || typeof part !== "object") return part;
  const type = part.type;
  if (SUPPORTED_CONTENT_TYPES.has(type)) return part;

  // Try to recover a meaningful identifier for the placeholder text.
  const source =
    part.source_url ?? part.url ?? part.file_path ?? part.path ?? part.name;
  const mime = part.mimeType ?? part.mime_type;
  if (type === "file" || type === "image" || type === "audio" || type === "video") {
    const where = source ? `: ${source}` : mime ? ` (${mime})` : "";
    return { type: "text", text: `[二进制文件${where}]` };
  }
  // Unknown / future block types — collapse generically.
  const label = part.text ?? `[${type ?? "unknown"}]`;
  return { type: "text", text: label };
}

/** Normalize a ToolMessage's content in place, returning whether it changed. */
function _normalizeToolMessage(result: ToolMessage): boolean {
  const content = result.content;
  if (!Array.isArray(content)) return false;

  let changed = false;
  const next = content.map((part: any) => {
    if (
      part &&
      typeof part === "object" &&
      !SUPPORTED_CONTENT_TYPES.has(part.type)
    ) {
      changed = true;
      return _sanitizeContentPart(part);
    }
    return part;
  });
  if (changed) (result as any).content = next;
  return changed;
}

class BinaryContentSanitizerMiddleware {
  name = "BinaryContentSanitizerMiddleware";

  /**
   * Rewrite any tool result that carries binary/multimodal content blocks the
   * LangGraph Rust backend cannot deserialize. Only array-typed content on a
   * `ToolMessage` is touched — plain-string tool results are left as-is.
   *
   * Although the primary offender is `read_file`, we inspect every tool result
   * so that MCP tools or future built-ins that emit `image`/`audio`/`video`
   * blocks are also covered.
   */
  wrapToolCall = (
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => any,
  ): any => {
    const result = handler(request);
    if (result instanceof Promise) {
      return result.then((r: any) => {
        if (r instanceof ToolMessage) _normalizeToolMessage(r);
        return r;
      });
    }
    if (result instanceof ToolMessage) _normalizeToolMessage(result);
    return result;
  };
}

export { BinaryContentSanitizerMiddleware };
