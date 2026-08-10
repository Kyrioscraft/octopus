/**
 * Tool-call view model for the chat UI.
 *
 * A `ToolCallEntry` is the structured, UI-facing view of a single tool
 * invocation. The raw wire format (LangChain `tool_calls` on an AI message +
 * a separate ToolMessage carrying the result) is normalized into this shape
 * by `TurnEventAccumulator` (in `turn/`), so the rendering components never
 * have to deal with the two-message split.
 *
 * Equivalent to yuxi's flattened tool-call model: one entry per invocation,
 * with status tracking (pending → done/error) and the result back-filled from
 * the matching ToolMessage.
 */

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

/** Props every tool-call row component accepts. */
export interface ToolCardProps {
  entry: ToolCallEntry;
}
