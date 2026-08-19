/**
 * Agent event protocol — pure types, no LangChain dependencies.
 *
 * Decouples consumers (server chat service, tentacle clients) from the
 * LangGraph stream format. The server consumes `AsyncIterable<AgentEvent>`
 * instead of poking at LangChain message objects directly. The LangChain-specific
 * normalization lives in engine/langchain-adapter.ts.
 *
 * Equivalent to a transport-agnostic view of Python `chat_service.py` events.
 */

import type { SubagentRegistryEntry } from "../agent/index.js";

// =============================================================================
// Standardized event model
// =============================================================================

/**
 * A transport-agnostic agent event (v2 typed protocol). The server assigns
 * per-thread `seq` and serializes these as NDJSON `StreamEvent`s; the client
 * applies targeted patches keyed by the stable ids. No LangChain message dumps
 * are forwarded — everything the UI needs is a typed field.
 *
 * Turn-boundary events (started/finished/error/interrupted) are owned by the
 * chat service layer, NOT emitted here.
 */
export type AgentEvent =
  | { type: "text.delta"; messageId: string; agentNs?: string; delta: string }
  | { type: "reasoning.delta"; messageId: string; agentNs?: string; delta: string }
  | { type: "tool.started"; toolCallId: string; name: string; agentNs?: string }
  | { type: "tool.args.delta"; toolCallId: string; index: number; argsDelta: string }
  | { type: "tool.result"; toolCallId: string; result: string; isError: boolean }
  | {
      type: "subagent.started";
      /** task tool_call_id — stable correlation key across started/finished. */
      callId: string;
      /** Resolved instance key ("tools:<run-id>") when known, else "pending:<callId>". */
      instanceKey: string;
      description: string;
      subagentName: string;
    }
  | { type: "subagent.finished"; instanceKey: string };

/** Input for running a fresh chat turn through the engine wrapper. */
export interface AgentRunInput {
  threadId: string;
  requestId: string;
  /** The compiled agent (from makeGraph). */
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
  langgraphConfig: Record<string, unknown>;
}

