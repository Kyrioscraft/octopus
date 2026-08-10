/**
 * Middleware that persists per-checkpoint state needed to resume a thread.
 * Equivalent to Python `cortex.resume_state.ResumeStateMiddleware`.
 */

import type { BaseMessage } from "@langchain/core/messages";

function _isAiMessage(msg: BaseMessage): boolean {
  return (msg as any).type === "ai" || (msg as any)._getType?.() === "ai";
}

function _extractContextTokens(messages: BaseMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (_isAiMessage(msg)) {
      const usage = (msg as any).usage_metadata as
        | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
        | undefined;
      if (!usage) continue;
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      if (inputTokens || outputTokens) return inputTokens + outputTokens;
      const total = usage.total_tokens ?? 0;
      if (total) return total;
    }
  }
  return undefined;
}

function _extractModelSpec(runtime: Record<string, unknown>): string | undefined {
  const ctx = runtime["context"];
  if (!ctx || typeof ctx !== "object") return undefined;
  const spec = (ctx as Record<string, unknown>)["effective_model"];
  return (typeof spec === "string" && spec) ? spec : undefined;
}

class ResumeStateMiddleware {
  name = "ResumeStateMiddleware";

  stateSchema = {
    _contextTokens: { default: () => undefined as number | undefined },
    _modelSpec: { default: () => undefined as string | undefined },
  };

  afterModel = async (
    state: Record<string, unknown> & { messages?: BaseMessage[] },
    runtime: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> => {
    const update: Record<string, unknown> = {};
    if (state.messages && state.messages.length > 0) {
      const tokens = _extractContextTokens(state.messages);
      if (tokens !== undefined) update["_contextTokens"] = tokens;
    }
    const spec = _extractModelSpec(runtime);
    if (spec) update["_modelSpec"] = spec;
    return Object.keys(update).length > 0 ? update : undefined;
  };
}

export { ResumeStateMiddleware };
