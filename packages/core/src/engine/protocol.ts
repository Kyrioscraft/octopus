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
  /**
   * Terminal full-value events (opencode `*.ended` semantics): the ONLY
   * replayable boundary. Deltas are live-only sugar — persisted streams drop
   * them at compaction and clients replaying from storage reconstruct state
   * purely from these terminal events, so live and history rendering run
   * through the same reducer.
   */
  | { type: "text.ended"; messageId: string; agentNs?: string; text: string }
  | { type: "reasoning.ended"; messageId: string; agentNs?: string; text: string }
  | { type: "tool.started"; toolCallId: string; name: string; agentNs?: string; /** Full parsed args — the announcement is deferred until args are complete, so they ride along here (durable) and a replayed row renders its command/file name immediately instead of "(empty)"/"(unknown)". Complements tool.result.args. */ args?: Record<string, unknown> }
  | { type: "tool.args.delta"; toolCallId: string; index: number; argsDelta: string; agentNs?: string }
  | { type: "tool.result"; toolCallId: string; result: string; isError: boolean; agentNs?: string; /** Full parsed args — the replayable boundary (args deltas are volatile, never persisted). */ args?: Record<string, unknown>; /** Tool name when the ToolMessage carries it — lets a row render standalone without pairing to tool.started. */ name?: string }
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

