/**
 * Validate shell commands against an allow-list without HITL interrupts.
 * Equivalent to Python `cortex.agent.ShellAllowListMiddleware`.
 */

import { ToolMessage } from "@langchain/core/messages";

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

const SHELL_ALLOW_ALL = Symbol("SHELL_ALLOW_ALL");

function isShellCommandAllowed(command: string, allowList: string[]): boolean {
  if (!command || allowList.length === 0) return false;
  const trimmed = command.trimStart();
  if (!trimmed) return false;
  let firstWord: string;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const endIdx = trimmed.indexOf(quote, 1);
    firstWord = endIdx > 0 ? trimmed.slice(1, endIdx) : trimmed.slice(1);
  } else {
    const spaceIdx = trimmed.search(/\s/);
    firstWord = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  }
  const normalized = firstWord.replace(/^.*[/\\]/, "").toLowerCase();
  return allowList.some((allowed) => allowed.toLowerCase() === normalized);
}

export { SHELL_ALLOW_ALL as ShellAllowAll };

class ShellAllowListMiddleware {
  name = "ShellAllowListMiddleware";
  private _allowList: string[];

  constructor(allowList: string[]) {
    if (!allowList || allowList.length === 0) {
      throw new Error("allowList must not be empty; disable shell access instead");
    }
    this._allowList = [...allowList];
  }

  private _validateToolCall = (request: ToolCallRequest): ToolMessage | undefined => {
    const toolCall = request.toolCall;
    if (toolCall.name !== "execute") return undefined;
    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const command = (args["command"] as string) || "";
    if (isShellCommandAllowed(command, this._allowList)) return undefined;
    const allowedStr = this._allowList.join(", ");
    return new ToolMessage({
      content: `Shell command rejected: \`${command}\` is not in the allow-list. ` +
        `Allowed commands: ${allowedStr}. Please use an allowed command or try another approach.`,
      name: "execute",
      tool_call_id: toolCall.id ?? "",
      status: "error",
    });
  };

  wrapToolCall = (
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => any,
  ): any => {
    const rejection = this._validateToolCall(request);
    if (rejection) return rejection;
    return handler(request);
  };
}

export { ShellAllowListMiddleware, isShellCommandAllowed };
