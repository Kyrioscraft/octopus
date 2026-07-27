/**
 * Shared types for tool-call rendering in the chat UI.
 *
 * A `ToolCallEntry` is the structured, UI-facing view of a single tool
 * invocation. The raw wire format (LangChain `tool_calls` on an AI message +
 * a separate ToolMessage carrying the result) is normalized into this shape
 * by `doStream` / `load` in Chat.tsx, so the rendering components never
 * have to deal with the two-message split.
 *
 * Equivalent to yuxi's flattened tool-call model: one entry per invocation,
 * with status tracking (pending → done/error) and the result back-filled from
 * the matching ToolMessage.
 */
import type { AskKind, AskQuestion, ResumeRequestBody } from "@octopus/tentacle";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallEntry {
  /** LangChain tool_call_id — used to pair the AI tool_call with its ToolMessage result. */
  id: string;
  /** Tool name: edit_file / write_file / read_file / execute / task / ... */
  name: string;
  /** Parsed tool arguments (already an object on the wire — LangChain parses the JSON). */
  args: Record<string, unknown>;
  /** Lifecycle status. `pending` = AI emitted the call, result not yet received. */
  status: ToolCallStatus;
  /** ToolMessage.content, back-filled when the matching `type:"tool"` chunk arrives. */
  result?: string;
  /** Originating subagent type, when this call came from a subagent's turn. */
  agentNs?: string;
}

/**
 * A subagent invocation (the `task` tool). Flattened view: we do NOT recurse
 * into the subagent's internal steps — only its type, description, and final
 * result are surfaced (yuxi's flat design).
 */
export interface SubagentEntry {
  agentNs: string;
  description: string;
  /** Final result text from the subagent (its last AI message), back-filled. */
  result?: string;
}

/** Props every tool-call card component accepts. */
export interface ToolCardProps {
  entry: ToolCallEntry;
}

// =============================================================================
// Turn timeline events
// =============================================================================
// A single assistant turn produces an interleaved sequence of events in real
// execution order: reasoning → tool call → tool result → reasoning → tool →
// ... → final text reply. Modeling the turn as an ordered `events[]` array
// (instead of separate reasoning/content/toolCalls fields) preserves the
// causal order, which is what makes agent UIs readable (Cline / Claude.ai /
// Cursor all render a strict timeline). This is the root-cause fix for the
// "推理-工具-推理-工具-回复-工具" interleaving looking chaotic.

export type TurnEventType = "reasoning" | "tool" | "text" | "subagent" | "ask";

export interface BaseTurnEvent {
  /** Stable id (used as React key). */
  id: string;
  /** Discriminator for the union. */
  type: TurnEventType;
}

/**
 * A contiguous span of reasoning (thinking) tokens. Multiple reasoning events
 * can exist in one turn — each represents a separate "thinking episode"
 * between tool calls. Collapses to a one-line summary when the turn finishes
 * (à la Claude.ai's "Thought for Ns").
 */
export interface ReasoningEvent extends BaseTurnEvent {
  type: "reasoning";
  /** Accumulated reasoning text. */
  text: string;
  /** Wall-clock duration of this reasoning span (ms), for the collapse summary. */
  startedAt: number;
}

/**
 * A single tool invocation. `entry.status` tracks pending → done/error; the
 * matching ToolMessage result is back-filled into `entry.result`. Adjacent
 * tool events may be visually grouped (the old ToolCallGroup behavior), but
 * each remains a first-class timeline entry so order is preserved.
 */
export interface ToolEvent extends BaseTurnEvent {
  type: "tool";
  entry: ToolCallEntry;
}

/**
 * The assistant's visible text reply (the "final answer" content, not
 * reasoning). Rendered without a card wrapper and given the highest visual
 * weight — this is the primary information the user came for.
 */
export interface TextEvent extends BaseTurnEvent {
  type: "text";
  text: string;
}

/**
 * A subagent (`task` tool) lifecycle marker. Flattened: only the type +
 * description are shown; the subagent's internal steps are NOT surfaced as
 * nested events (flat design, consistent with yuxi / Cline's task tool).
 */
export interface SubagentEvent extends BaseTurnEvent {
  type: "subagent";
  agentNs: string;
  description: string;
  /** Final result, back-filled from the task tool's ToolMessage. */
  result?: string;
}

/**
 * A read-only marker in the timeline recording that the agent asked the user
 * something (tool approval / discussion / clarification). The interactive UI
 * lives in the input-area `AskPanel` (single source of truth for the user's
 * input); this event only leaves a causal trace in the message stream so the
 * user can see "the agent was waiting on me here."
 *
 * `resolved=false` while the AskPanel is open; flipped to `true` (with the
 * `resolution` summary) once the user submits, so the timeline row collapses
 * to a one-line outcome ("✓ 已批准 · execute" / "已选: React" / the typed text).
 */
export interface AskEvent extends BaseTurnEvent {
  type: "ask";
  kind: AskKind;
  questions: AskQuestion[];
  /** True once the user has submitted an answer via the AskPanel. */
  resolved?: boolean;
  /** The submitted body, for rendering the collapsed summary. */
  resolution?: ResumeRequestBody;
}

export type TurnEvent =
  | ReasoningEvent
  | ToolEvent
  | TextEvent
  | SubagentEvent
  | AskEvent;
