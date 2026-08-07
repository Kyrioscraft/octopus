// =============================================================================
// Stream event processing — the big switch statement that routes every
// StreamEvent to the appropriate handler.
// Extracted from tui-adapter.ts.
// =============================================================================

import type { StreamEvent } from "@octopus/tentacle";
import { getLogger } from "../utils/logging.js";
import type { StreamState, TuiAdapterCallbacks, ExecutionContext } from "./tui-adapter.js";
import {
  extractToken,
  handleSubagentStarted,
  handleSubagentMessage,
  handleMainToolCall,
  handleMainToolResult,
} from "./tool-tracker.js";

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

  logger.debug("stream event", { status: event.status, threadId: ctx.threadId });

  switch (event.status) {
    case "init": {
      // Server acknowledged the request — update metadata
      const meta = event.meta ?? {};
      if (meta.thread_id && !ctx.threadId) {
        ctx.threadId = meta.thread_id as string;
        ctx.callbacks.onThreadResolved(ctx.threadId);
      }
      break;
    }

    case "loading": {
      const msg = (event.msg ?? {}) as Record<string, unknown>;
      const msgType = msg.type as string | undefined;
      const agentNs = msg.agent_ns as string | undefined;

      // Synthetic subagent_started chunk — carries the system prompt.
      if (msgType === "subagent_started") {
        handleSubagentStarted(state, callbacks, agentNs ?? "subagent", msg);
        break;
      }

      // Messages originating inside a subagent — route to its tracker.
      if (agentNs) {
        handleSubagentMessage(state, callbacks, agentNs, msg, msgType ?? "", event);
        break;
      }

      // Main-agent tools — every tool call becomes its own standalone
      // `role:"tool"` message. No more Explore aggregation.
      // The tool_calls chunk creates messages in "running" state;
      // tool result messages update status to done/error.
      if (msgType === "ai" || msgType === "AIMessage") {
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls && toolCalls.length > 0) {
          logger.debug("main agent tool_calls", {
            count: toolCalls.length,
            names: toolCalls.map((tc) => tc.name),
          });
          for (const tc of toolCalls) {
            const tcName = (tc.name as string) ?? "";
            handleMainToolCall(state, callbacks, tcName, (tc.args ?? {}) as Record<string, unknown>, tc.id as string | undefined);
          }
        }
      } else if (msgType === "tool") {
        handleMainToolResult(state, callbacks, (msg.name as string) ?? "", msg, event);
        // Tool result content stays in the tool message, not assistant text.
        break;
      }

      // Main agent token fragment — append to assistant message.
      const token = extractToken(event.response);
      if (token) {
        state.assistantContent += token;
        state.outputTokens++;

        if (!state.assistantMessageId) {
          // Create a new assistant message
          state.assistantMessageId = `msg_${Date.now()}`;
          callbacks.addMessage({
            id: state.assistantMessageId,
            role: "assistant",
            content: token,
            timestamp: Date.now(),
          });
        } else {
          // Update existing message
          callbacks.updateMessage(state.assistantMessageId, {
            content: state.assistantContent,
          });
        }
      }
      break;
    }

    case "reasoning": {
      const msg = (event.msg ?? {}) as Record<string, unknown>;
      const agentNs = msg.agent_ns as string | undefined;

      // Subagent reasoning — route to its tracker (don't pollute main reasoning).
      if (agentNs) {
        handleSubagentMessage(state, callbacks, agentNs, msg, (msg.type as string) ?? "", event);
        break;
      }

      // Main agent reasoning token (thinking/reasoning_content)
      const token = extractToken(event.response);
      if (token) {
        state.reasoningContent += token;
        // Store in metadata for display
        if (state.assistantMessageId) {
          callbacks.updateMessage(state.assistantMessageId, {
            metadata: { reasoning: state.reasoningContent },
          });
        }
      }
      break;
    }

    case "finished": {
      // Agent completed — finalize
      state.requestCount++;
      const meta = event.meta ?? {};
      if (meta.thread_id) {
        ctx.threadId = meta.thread_id as string;
      }
      // Token counts may be in the finished event
      if (typeof meta.input_tokens === "number") {
        state.inputTokens += meta.input_tokens;
      }
      if (typeof meta.output_tokens === "number") {
        state.outputTokens += meta.output_tokens;
      }
      break;
    }

    case "interrupted": {
      // HITL interrupt — the agent is waiting for approval
      callbacks.setSpinner(null);
      callbacks.onInterrupted(event.message ?? event.error_message ?? "Agent paused — awaiting approval");
      break;
    }

    case "ask_user_question_required": {
      // HITL interrupt — the server paused the agent because one or more tool
      // calls (edit_file, write_file, execute, …) need user approval before
      // they execute. The app must show the ApprovalMenu and call
      // resumeAgentTask(approved) to continue.
      callbacks.setSpinner(null);
      const interruptMeta = (event.meta?.interrupt ?? {}) as Record<string, unknown>;
      const questions = (event.questions as unknown[]) ?? (interruptMeta.questions as unknown[]) ?? [];
      const actionRequests = (interruptMeta.actionRequests as unknown[]) ?? [];
      callbacks.onApprovalRequired(questions, actionRequests);
      break;
    }

    case "error": {
      callbacks.onError(event.error_message ?? event.message ?? "Unknown error");
      break;
    }

    case "warning": {
      // Non-fatal warning — display as app message, strip technical IDs
      let text = event.message ?? "Warning";
      // Strip tool call IDs: "Tool call <name> with id <uuid> was cancelled..." → "Tool call <name> was cancelled..."
      text = text.replace(/\s+with\s+id\s+\S+/, "");
      callbacks.addMessage({
        id: `warn_${Date.now()}`,
        role: "app",
        content: `⚠ ${text}`,
        timestamp: Date.now(),
      });
      break;
    }

    default:
      break;
  }
}
