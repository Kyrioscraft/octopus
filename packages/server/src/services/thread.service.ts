/**
 * Thread service — session CRUD + business rules.
 *
 * Pure business orchestration: wraps the db layer and applies domain rules
 * (default title, message stripping on list). No HTTP, no streaming — the
 * route layer calls these and encodes the result as JSON.
 *
 * Equivalent to Python `chat_service.py` thread-management portion.
 */

import { v4 as uuid } from "uuid";
import {
  createThread,
  getThread,
  getMessages,
  listThreads,
  listThreadsByWorkspace,
  updateThreadTitle,
  updateThreadAccessMode,
  deleteThread,
} from "../db/index.js";
import type { ThreadRow, MessageRow } from "../db/index.js";

/** A thread without its messages — the shape list endpoints return. */
type ThreadSummary = Omit<ThreadRow, "messages">;

/** Default title for a freshly created thread. */
const DEFAULT_TITLE = "新对话";

/**
 * List threads for a user, with messages stripped out (summaries only).
 * Ordered by created_at desc by the db layer.
 */
export function listUserThreads(userId: string): ThreadSummary[] {
  return listThreads(userId).map(({ messages: _m, ...rest }) => rest);
}

/**
 * List threads scoped to a workspace (or unscoped when workspaceId is null/omitted).
 * Mirrors listUserThreads but delegates to the workspace-aware db query.
 */
export function listUserThreadsByWorkspace(
  userId: string,
  workspaceId?: string | null,
): ThreadSummary[] {
  // undefined = all threads for the user; null = only unbound; string = that ws.
  const scope = workspaceId === undefined ? undefined : workspaceId;
  return listThreadsByWorkspace(userId, scope).map(({ messages: _m, ...rest }) => rest);
}

/** Get a thread's message history (ordered by created_at asc). */
export function getThreadHistory(threadId: string): MessageRow[] | null {
  const thread = getThread(threadId);
  if (!thread) return null;
  return thread.messages;
}

/** Explicitly create a thread (Phase F+ — currently creation is implicit). */
export function createUserThread(opts: {
  userId: string;
  title?: string;
  agentId?: string;
}): ThreadSummary {
  const id = `thread_${uuid()}`;
  createThread({
    id,
    userId: opts.userId,
    title: opts.title ?? DEFAULT_TITLE,
    agentId: opts.agentId ?? "",
  });
  // Re-read to get the full row (db may normalize fields).
  return getThread(id) as ThreadSummary;
}

/** Rename a thread. Returns the updated title, or null if not found. */
export function renameThread(
  threadId: string,
  title: string
): { title: string } | null {
  const updated = updateThreadTitle(threadId, title?.trim() || DEFAULT_TITLE);
  if (!updated) return null;
  return { title: updated.title };
}

/**
 * Persist a new access mode on the thread. Called when the user switches the
 * mode mid-session so the resume path picks up the latest mode without
 * requiring a new message. Returns the stored mode, or null if not found.
 */
export function setThreadAccessMode(
  threadId: string,
  accessMode: string,
): { accessMode: string } | null {
  const updated = updateThreadAccessMode(threadId, accessMode);
  if (!updated) return null;
  return { accessMode: updated.accessMode };
}

/** Delete a thread. */
export function deleteThreadById(threadId: string): void {
  deleteThread(threadId);
}

export { getMessages };
