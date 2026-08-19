// =============================================================================
// Tool tracking — subagent and main-agent tool call/result tracking.
// Extracted from tui-adapter.ts.
// =============================================================================

import type { StreamEvent } from "@octopus/tentacle";
import type { SubagentToolExec } from "../types.js";
import { isFileEditTool, computeDiffStats } from "./tool-utils.js";
import type { StreamState, TuiAdapterCallbacks } from "./tui-adapter.js";

// =============================================================================
// Tracker interfaces
// =============================================================================

/**
 * Tracks one subagent invocation as it streams. Keyed by `agentNs` (the
 * subagent type, e.g. "general-purpose") in `StreamState.subagents`.
 */
export interface SubagentTracker {
  messageId: string;
  agentType: string;
  description: string;
  systemPrompt?: string;
  status: "running" | "done";
  tools: SubagentToolExec[];
}

export interface MainToolTracker {
  messageId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  diffStats?: { added: number; removed: number };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract a text token from a stream event response field.
 * The response may be a string, an array of content parts, or an object.
 */
export function extractToken(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    // Could be an array of content parts
    return response
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text"
        && typeof (part as Record<string, unknown>).text === "string"
      )
      .map((part) => (part as Record<string, unknown>).text as string)
      .join("");
  }
  if (typeof response === "object" && response !== null) {
    // Could be a message object with content
    const obj = response as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    // Handle content as array of content blocks (OpenAI/Anthropic format)
    if (Array.isArray(obj.content)) {
      return extractToken(obj.content);
    }
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

// =============================================================================
// Subagent tracking helpers
// =============================================================================

/**
 * Ensure a SubagentTracker exists for the given namespace, creating the TUI
 * message if necessary.
 */
export function ensureSubagent(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  agentNs: string,
): SubagentTracker {
  let tracker = state.subagents.get(agentNs);
  if (!tracker) {
    tracker = {
      messageId: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      agentType: agentNs,
      description: "",
      status: "running",
      tools: [],
    };
    state.subagents.set(agentNs, tracker);
    // Insert before assistant message when possible
    if (state.assistantMessageId) {
      callbacks.insertMessage({
        id: tracker.messageId,
        role: "subagent",
        content: "",
        timestamp: Date.now(),
        metadata: {
          agentType: tracker.agentType,
          description: "",
          status: "running",
          tools: [],
        },
      }, state.assistantMessageId);
    } else {
      callbacks.addMessage({
        id: tracker.messageId,
        role: "subagent",
        content: "",
        timestamp: Date.now(),
        metadata: {
          agentType: tracker.agentType,
          description: "",
          status: "running",
          tools: [],
        },
      });
    }
  }
  return tracker;
}

/** Push the current tracker state to the TUI message. */
export function flushSubagent(callbacks: TuiAdapterCallbacks, tracker: SubagentTracker): void {
  callbacks.updateMessage(tracker.messageId, {
    metadata: {
      agentType: tracker.agentType,
      description: tracker.description,
      systemPrompt: tracker.systemPrompt,
      status: tracker.status,
      tools: tracker.tools,
    },
  });
}

/**
 * v2 `subagent.started` — register the subagent tracker (carries name +
 * description; system prompt comes from the server's subagent registry).
 */
export function handleSubagentStarted(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  subagentName: string,
  ev: Extract<StreamEvent, { type: "subagent.started" }>,
): void {
  const tracker = ensureSubagent(state, callbacks, ev.instanceKey);
  tracker.agentType = subagentName;
  tracker.description = ev.description ?? "";
  tracker.systemPrompt = undefined;
  flushSubagent(callbacks, tracker);
}

/**
 * v2 subagent-internal events (carry agentNs) — track the subagent's tool
 * lifecycle and finish state.
 */
export function handleSubagentMessage(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  agentNs: string,
  ev: StreamEvent,
): void {
  const tracker = ensureSubagent(state, callbacks, agentNs);

  switch (ev.type) {
    case "tool.started":
      if (ev.name === "task") break;
      tracker.tools.push({
        toolName: ev.name,
        args: {},
        status: "running",
        toolCallId: ev.toolCallId,
      });
      flushSubagent(callbacks, tracker);
      break;
    case "tool.result": {
      const pending = [...tracker.tools]
        .reverse()
        .find((t) => t.status === "running" && t.toolCallId === ev.toolCallId);
      if (pending) {
        pending.status = ev.isError ? "error" : "done";
        pending.resultSummary = summarizeToolResult(pending.toolName, ev.result);
      }
      flushSubagent(callbacks, tracker);
      break;
    }
    case "subagent.finished":
      tracker.status = "done";
      flushSubagent(callbacks, tracker);
      break;
    default:
      break;
  }
}

/**
 * Produce a short human-readable summary of a tool's result content.
 * - read_file → word count
 * - execute → first line / exit status
 * - web_search → result count heuristic
 * - fallback → first line truncated
 */
export function summarizeToolResult(toolName: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const name = toolName.toLowerCase();
  if (name === "read_file" || name === "read") {
    return `${formatWordCount(trimmed)}`;
  }
  if (name === "execute" || name === "shell" || name === "bash") {
    const firstLine = trimmed.split("\n").find((l) => l.trim()) ?? "";
    return firstLine.slice(0, 80) || "done";
  }
  if (name.includes("search")) {
    return trimmed.slice(0, 60);
  }
  const firstLine = trimmed.split("\n")[0] ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

/** Count words in content — handles CJK characters (counted per-char). */
export function formatWordCount(content: string): string {
  // Count CJK characters individually; non-CJK runs split on whitespace.
  const cjkMatches = content.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = content.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ");
  const wordCount = nonCjk.split(/\s+/).filter((w) => w.length > 0).length;
  const total = cjkCount + wordCount;
  if (total >= 10000) return `${(total / 1000).toFixed(1)}k 字`;
  return `${total.toLocaleString()} 字`;
}

// =============================================================================
// Main-agent tool handling — one standalone tool row per call
// =============================================================================

export function handleMainToolCall(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  toolName: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): void {
  const id = toolCallId ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const messageId = `tool_${id}`;
  const diffStats = isFileEditTool(toolName) ? computeDiffStats(toolName, args) : undefined;
  state.toolMessages.set(id, { messageId, toolName, args, status: "running", ...(diffStats ? { diffStats } : {}) });
  callbacks.addMessage({
    id: messageId, role: "tool", content: "", timestamp: Date.now(),
    metadata: { toolName, toolStatus: "running", toolArgs: args, ...(diffStats ? { diffStats } : {}) },
  });
}

export function handleMainToolResult(
  state: StreamState,
  callbacks: TuiAdapterCallbacks,
  ev: Extract<StreamEvent, { type: "tool.result" }>,
): void {
  let entry: MainToolTracker | undefined;
  if (ev.toolCallId) entry = state.toolMessages.get(ev.toolCallId);
  if (!entry) { for (const e of state.toolMessages.values()) { if (e.status === "running") { entry = e; break; } } }
  if (!entry) return;
  const isError = ev.isError;
  entry.status = isError ? "error" : "done";
  callbacks.updateMessage(entry.messageId, {
    metadata: {
      toolName: entry.toolName,
      toolStatus: entry.status === "error" ? "error" : "done",
      toolArgs: entry.args,
      ...(entry.diffStats ? { diffStats: entry.diffStats } : {}),
      result: ev.result.slice(0, 200),
      resultSummary: summarizeToolResult(entry.toolName, ev.result),
    },
  });
}
