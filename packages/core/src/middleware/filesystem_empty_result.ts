/**
 * Normalize empty `ls`/`glob` tool output for the model.
 *
 * Equivalent to Python `cortex.filesystem_empty_result._FilesystemEmptyResultMiddleware`.
 */

import { ToolMessage } from "@langchain/core/messages";

const EMPTY_FILE_LIST_SENTINEL = "No files found";
const FILE_LIST_TOOLS = new Set(["ls", "glob"]);

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

class FilesystemEmptyResultMiddleware {
  name = "FilesystemEmptyResultMiddleware";

  private _normalizeResult = (result: any): any => {
    if (
      result instanceof ToolMessage &&
      result.name &&
      FILE_LIST_TOOLS.has(result.name) &&
      (result as any).status === "success" &&
      result.content === "[]"
    ) {
      result.content = EMPTY_FILE_LIST_SENTINEL;
    }
    return result;
  };

  wrapToolCall = (
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => any,
  ): any => {
    const result = handler(request);
    if (result instanceof Promise) {
      return result.then((r) => this._normalizeResult(r));
    }
    return this._normalizeResult(result);
  };
}

export { FilesystemEmptyResultMiddleware };
