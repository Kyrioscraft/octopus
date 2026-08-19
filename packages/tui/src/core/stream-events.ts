// =============================================================================
// Stream event processing — the big switch statement that routes every
// StreamEvent to the appropriate handler.
// Extracted from tui-adapter.ts.
//
// v2 typed protocol: discriminate on `type` (the legacy `status`-based chunks
// no longer exist on the server). This module powers the LEGACY
// message-based rendering path (tui-adapter); the primary block-based path
// lives in block-stream.ts.
// =============================================================================

import type { StreamEvent } from "@octopus/tentacle";
import { getLogger } from "../utils/logging.js";
import type { StreamState, TuiAdapterCallbacks, ExecutionContext } from "./tui-adapter.js";

const logger = getLogger("tui.adapter");

// =============================================================================
// Process a single stream event
// =============================================================================

export function processStreamEvent(
  event: StreamEvent,
  state: StreamState,
  ctx: ExecutionContext,
): void {
  const { callbacks } = ctx;

  logger.debug("stream event", { type: event.type, threadId: ctx.threadId });

  switch (event.type) {
    case "turn.started": {
      if (event.threadId && !ctx.threadId) {
        ctx.threadId = event.threadId;
        ctx.callbacks.onThreadResolved(ctx.threadId);
      }
      break;
    }

    case "text.delta":
    case "text.ended": {
      if (event.agentNs) break; // subagent text — not main-assistant content
      const token = event.type === "text.delta" ? event.delta : null;
      if (token) {
        state.assistantContent += token;
        state.outputTokens++;

        if (!state.assistantMessageId) {
          state.assistantMessageId = `msg_${Date.now()}`;
          callbacks.addMessage({
            id: state.assistantMessageId,
            role: "assistant",
            content: token,
            timestamp: Date.now(),
          });
        } else {
          callbacks.updateMessage(state.assistantMessageId, {
            content: state.assistantContent,
          });
        }
      }
      break;
    }

    case "reasoning.delta":
    case "reasoning.ended": {
      if (event.agentNs) break;
      const token = event.type === "reasoning.delta" ? event.delta : null;
      if (token) {
        state.reasoningContent += token;
        if (state.assistantMessageId) {
          callbacks.updateMessage(state.assistantMessageId, {
            metadata: { reasoning: state.reasoningContent },
          });
        }
      }
      break;
    }

    case "turn.finished": {
      state.requestCount++;
      break;
    }

    case "turn.interrupted": {
      callbacks.setSpinner(null);
      callbacks.onInterrupted("Agent paused — awaiting approval");
      break;
    }

    case "ask": {
      // HITL interrupt — the server paused the agent because tool calls need
      // approval. The app shows the ApprovalMenu and calls
      // resumeAgentTask(approved) to continue.
      callbacks.setSpinner(null);
      const questions = event.questions ?? [];
      const actionRequests = questions
        .map((q) => q.context?.actionRequests)
        .filter((a): a is NonNullable<typeof a> => !!a)
        .flat();
      callbacks.onApprovalRequired(questions, actionRequests);
      break;
    }

    case "turn.error": {
      callbacks.onError(event.message ?? "Unknown error");
      break;
    }

    case "tool.started":
    case "tool.args.delta":
    case "tool.result":
    case "subagent.started":
    case "subagent.finished":
      // Tool/subagent detail is rendered by the block-based path; the legacy
      // message-based path keeps only the assistant text/reasoning timeline.
      break;

    default:
      // heartbeat / idle — keepalives, nothing to render.
      break;
  }
}
