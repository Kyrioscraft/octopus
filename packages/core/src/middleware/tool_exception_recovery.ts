/**
 * Convert expected tool failures into recoverable tool messages.
 * Equivalent to Python `cortex.agent._ToolExceptionRecoveryMiddleware`.
 *
 * Also hosts diagnostic logging (OCTOPUS_TOOL_TRACE=1) for the "empty tool
 * args" investigation: logs every model response's tool_calls AND
 * invalid_tool_calls (LangChain's raw argument strings for calls that failed
 * JSON/zod parsing), plus every tool invocation's args. The invalid_tool_calls
 * log is the key evidence — it shows whether the model sent empty arguments
 * or whether streamed argument deltas were corrupted in transit.
 */

import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import { getLogger } from "../logging.js";

const logger = getLogger("agent.tool-recovery");

const TOOL_TRACE = process.env.OCTOPUS_TOOL_TRACE === "1";

function _snippet(s: unknown, max = 300): string {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (str === undefined) return "undefined";
  return str.length > max ? str.slice(0, max) + `…(+${str.length - max})` : str;
}

interface ToolCallRequest {
  toolCall: { id?: string; name: string; args?: Record<string, unknown> };
  state?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

class ToolExceptionRecoveryMiddleware {
  name = "ToolExceptionRecoveryMiddleware";

  /**
   * Log the model's raw tool-call output on every LLM response when tracing.
   * `invalid_tool_calls` carries the raw `arguments` string for calls whose
   * arguments failed to parse (empty / corrupted JSON) — the primary signal
   * for the GLM empty-args investigation.
   */
  wrapModelCall = (
    request: { result?: any; [key: string]: unknown },
    handler: (req: any) => any,
  ): any => {
    const result = handler(request);
    if (!TOOL_TRACE || !(result instanceof Promise)) return result;
    return result.then((res: any) => {
      try {
        const msgs = res?.messages ?? (Array.isArray(res) ? res : [res]);
        const last = msgs[msgs.length - 1];
        if (last?.tool_calls?.length || last?.invalid_tool_calls?.length) {
          for (const tc of last.tool_calls ?? []) {
            logger.info(
              `[tool-trace] model tool_call name=${tc.name} id=${tc.id} args=${_snippet(tc.args)}`,
            );
          }
          for (const tc of last.invalid_tool_calls ?? []) {
            logger.warn(
              `[tool-trace] model INVALID tool_call name=${tc.name} id=${tc.id} ` +
                `args=${_snippet(tc.args)} error=${_snippet(tc.error)}`,
            );
          }
        }
      } catch {
        /* tracing must never break the model call */
      }
      return res;
    });
  };

  private _errorMessage = (request: ToolCallRequest, error: Error): ToolMessage => {
    const toolCall = request.toolCall;
    if (TOOL_TRACE) {
      logger.warn(
        `[tool-trace] tool ERROR name=${toolCall.name} args=${_snippet(toolCall.args)} error=${_snippet(error.message)}`,
      );
    }
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
    if (TOOL_TRACE) {
      const args = request.toolCall.args;
      const empty =
        args === undefined || Object.keys(args ?? {}).length === 0;
      logger.info(
        `[tool-trace] invoke name=${request.toolCall.name} id=${request.toolCall.id} ` +
          `emptyArgs=${empty} args=${_snippet(args)}`,
      );
    }
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
