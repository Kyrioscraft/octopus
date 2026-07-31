/**
 * Generic turn-event model for the conversation.
 *
 * A single assistant turn produces an interleaved sequence of events in real
 * execution order: reasoning → tool call → tool result → reasoning → tool →
 * ... → final text reply. Modeling the turn as an ordered `events[]` array
 * (instead of separate reasoning/content/toolCalls fields) preserves the
 * causal order, which is what makes agent UIs readable (Cline / Claude.ai /
 * Cursor all render a strict turn-event sequence).
 *
 * Tool-call details live in `rows/tools/types.ts` (`ToolCallEntry`, now under
 * `chat/rows/tools/` — a sibling of `turn/`); subagent delegation, HITL asks,
 * reasoning, and text are all modeled here as first-class event types so the
 * turn stays a single uniform sequence regardless of what the agent is doing.
 *
 * Equivalent to yuxi's turn-event model. The raw wire format (LangChain
 * streaming chunks) is normalized into these events by `TurnEventAccumulator`.
 */
import type { AskKind, AskQuestion, ResumeRequestBody } from "@octopus/tentacle";
import type { ToolCallEntry } from "../rows/tools/types.js";

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
 * tool events may be visually grouped, but each remains a first-class timeline
 * entry so order is preserved.
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
 * A subagent (`task` tool) lifecycle marker. Nested-container view: the
 * subagent owns an internal `events[]` timeline (recursively rendered), so its
 * internal reasoning/tool/text steps are surfaced as a collapsible nested tree
 * (à la zcode / opencode), not flattened into a single result string.
 *
 * `status` drives default expansion: "streaming" → expanded (live progress),
 * "done" → collapsed to a summary.
 */
export interface SubagentEvent extends BaseTurnEvent {
  type: "subagent";
  /**
   * Per-invocation instance key used for nesting/lookup. This is either a
   * placeholder (`pending:<toolCallId>`, emitted at subagent_started before the
   * real key is known) or the real `tools:<run-id>` (from LangGraph's
   * checkpoint namespace, unique per subagent invocation). NOT a display name.
   */
  agentNs: string;
  /**
   * Human-readable subagent TYPE (e.g. "Explore", "general-purpose"), carried
   * from `lc_agent_name` / `subagent_type`. Shown in the row; never used as a
   * lookup key (the same type can appear across multiple invocations).
   */
  displayName?: string;
  description: string;
  /** Nested internal timeline (reuses TurnEvent → supports recursion). */
  events: TurnEvent[];
  /** Lifecycle: streaming (in progress) or done (result returned to main agent). */
  status: "streaming" | "done";
  /** Final result, for the collapsed summary. */
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
