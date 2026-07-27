/**
 * Convert expected tool failures into recoverable tool messages.
 * Equivalent to Python `cortex.agent._ToolExceptionRecoveryMiddleware`.
 */

import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

class ToolExceptionRecoveryMiddleware {
  name = "ToolExceptionRecoveryMiddleware";

  private _errorMessage = (request: ToolCallRequest, error: Error): ToolMessage => {
    const toolCall = request.toolCall;
    const content = error.message || `${toolCall.name} failed with no error detail`;
    return new ToolMessage({
      content,
      name: toolCall.name,
      tool_call_id: toolCall.id ?? "",
      status: "error",
    });
  };

  wrapToolCall = (
    request: ToolCallRequest,
    handler: (req: ToolCallRequest) => any,
  ): any => {
    try {
      const result = handler(request);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          // GraphInterrupt is control flow, NOT a tool error — re-throw so
          // langgraph's ToolNode + checkpointer can pause the graph correctly.
          // Without this, an ask_user_question tool's interrupt() would be
          // swallowed into an error ToolMessage and the HITL pause never
          // happens (the model just sees a "failed" tool and carries on).
          if (error instanceof Error && isGraphInterrupt(error)) throw error;
          const err = error instanceof Error ? error : new Error(String(error));
          return this._errorMessage(request, err);
        });
      }
      return result;
    } catch (error: unknown) {
      // Same re-throw for the synchronous path.
      if (error instanceof Error && isGraphInterrupt(error)) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      return this._errorMessage(request, err);
    }
  };
}

export { ToolExceptionRecoveryMiddleware };
