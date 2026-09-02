/**
 * Chat service — agent stream orchestration.
 *
 * Consumes a LangGraph agent stream, translates raw graph events into NDJSON
 * StreamEvent chunks, persists messages, handles HITL interrupts and client
 * disconnects. Both the `POST /agent` and `POST /resume` routes delegate their
 * streaming work here — the route only creates the ReadableStream and passes
 * an `emit` callback (wrapping `controller.enqueue`).
 *
 * No HTTP/Hono dependency: the route owns the transport, the service owns the
 * business logic + protocol serialization.
 *
 * Equivalent to Python `chat_service.py::stream_agent_chat` / `stream_agent_resume`.
 */

import { v4 as uuid } from "uuid";
import { Command } from "@langchain/langgraph";
import {
  generateTitle,
  getLogger,
  wrapAgentStream,
} from "@octopus/core";
import type { SubagentRegistryEntry, AgentEvent } from "@octopus/core";
import { addMessage, addMessages, getMessages, mergeMessageExtra } from "../db/index.js";
import type { MessageRow } from "../db/index.js";

const logger = getLogger("chat.service");

// =============================================================================
// Types
// =============================================================================

/**
 * Transport-boundary events owned by this service layer (turn lifecycle, HITL
 * ask, /events control). Content events come from core's AgentEvent; both are
 * serialized as NDJSON `StreamEvent`s with a per-thread `seq` assigned by the
 * route's run-registry wrapper before enqueue/persist.
 */
export type BoundaryEvent =
  | { type: "turn.started"; threadId: string; requestId: string; runStartedAt: number; /** Fresh turns only (POST /agent); resume turns omit it and continue the same turn without a user bubble. */ userMessage?: string; /** Attachments of this turn (wire refs, no absPath) — mirrors the persisted extraMetadata.attachments so replaying clients render chips. */ attachments?: AttachmentWireRef[] }
  | { type: "turn.finished"; threadId: string; title?: string; durationMs?: number }
  | { type: "thread.title.updated"; threadId: string; title: string }
  | { type: "turn.error"; errorType: string; message: string; threadId?: string }
  | { type: "turn.interrupted"; partialSaved: boolean; durationMs?: number }
  | { type: "ask"; kind: AskKind; questions: AskQuestion[]; thread_id: string }
  // Persisted by the /resume route BEFORE the resumed run's events — models
  // ask as a request/response pair (see tentacle StreamEvent "ask.resolved").
  | { type: "ask.resolved"; kind: AskKind; resolution: ResumeRequestBody }
  | { type: "idle"; threadId?: string }
  | { type: "heartbeat" };

/** Everything the service may emit on the wire (seq assigned downstream). */
export type WireEvent = AgentEvent | BoundaryEvent;

/** Emit a chunk to the client. The route wraps controller.enqueue here. */
export type Emit = (chunk: WireEvent) => void;

/** Input for a fresh chat turn. */
export interface ChatInput {
  threadId: string;
  userMessage: string;
  requestId: string;
  isNewThread: boolean;
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
  langgraphConfig: Record<string, unknown>;
  /** Attachments uploaded by the client for this turn — already validated
   *  (path resolved inside the workspace) by the route. Expanded into the
   *  graph input as image_url blocks / inlined text. */
  attachments?: ResolvedAttachment[];
  /** Model spec for title generation on new threads. */
  modelSpec?: string;
  /** Signal from the run registry — aborted by an explicit /stop request.
   *  Client disconnects do NOT abort the run (it continues in background). */
  abortSignal?: AbortSignal;
  /** Run start timestamp (run-registry startedAt) — used to compute and
   *  persist the turn's work duration ("已工作 Xm" indicator). */
  startedAt?: number;
}

/** A chat attachment with its server-side resolved absolute path. The wire
 * shape (path/name/mime/size) mirrors tentacle's AttachmentRef. */
export interface ResolvedAttachment {
  path: string;
  name: string;
  mime?: string;
  size?: number;
  /** Absolute filesystem path, resolved by the route via the workspace root. */
  absPath: string;
}

/** Wire/persisted form — everything except the server-local absPath. */
export type AttachmentWireRef = Omit<ResolvedAttachment, "absPath">;

/** Input for resuming a HITL-interrupted turn. */
export interface ResumeInput {
  threadId: string;
  requestId: string;
  /** Structured resume body (replaces the legacy `approved: boolean`). */
  resumeBody: ResumeRequestBody;
  agent: any;
  subagentRegistry: Map<string, SubagentRegistryEntry>;
  langgraphConfig: Record<string, unknown>;
  /** Signal from the run registry — aborted by an explicit /stop request. */
  abortSignal?: AbortSignal;
  /** Run start timestamp — stamps work_duration_ms like streamChat. */
  startedAt?: number;
}


// =============================================================================
// Ask-the-user protocol types (mirror @octopus/tentacle — kept local to avoid
// a server → tentacle dependency, which would break the web→tentacle /
// server→core architecture boundary). These describe the wire shape of the
// `ask_user_question_required` chunk and the resume request body.
// =============================================================================

export type AskKind = "tool_approval" | "plan_approval" | "discussion" | "clarify";

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface AskQuestion {
  question_id: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  context?: {
    actionRequests?: Array<{
      name: string;
      args: Record<string, unknown>;
      description?: string;
    }>;
    source?: string;
    reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>;
  };
}

export interface AskUserQuestionPayload {
  kind: AskKind;
  questions: AskQuestion[];
  thread_id: string;
}

/**
 * Resume request body. Backwards-compatible: a legacy client sending only
 * `{ approved: boolean }` is folded into `kind: "tool_approval"` with a
 * single all-approve/all-reject decision list.
 */
export interface ResumeRequestBody {
  approved?: boolean;
  kind?: AskKind;
  /** plan_approval — revision feedback when the plan is rejected. */
  feedback?: string;
  decisions?: Array<
    | { type: "approve" }
    | { type: "always"; tool?: string }
    | { type: "reject"; message?: string }
    | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }
  >;
  answers?: Array<{
    question_id: string;
    selection?: string | string[];
    text?: string;
  }>;
}

// =============================================================================
// Persistence helpers (moved from chat.ts)
// =============================================================================

/** Persist user message to thread store. The optional agent name is stored
 *  in extraMetadata — message-level agent binding (phase 3 of the agent
 *  migration, mirroring opencode's per-message agent field). Attachments
 *  (wire refs without absPath) ride along in extraMetadata so history loads
 *  can render attachment chips. */
export function saveUserMessage(
  threadId: string,
  content: string,
  agent?: string,
  attachments?: ResolvedAttachment[],
): void {
  const wireAttachments = attachments?.map(({ absPath: _absPath, ...ref }) => ref);
  const extraMetadata: Record<string, unknown> | undefined =
    agent || wireAttachments
      ? {
          ...(agent ? { agent } : {}),
          ...(wireAttachments ? { attachments: wireAttachments } : {}),
        }
      : undefined;
  addMessage(threadId, {
    id: `msg_${Date.now()}`,
    role: "user",
    content,
    extraMetadata,
    createdAt: new Date().toISOString(),
  });
}

/** Extract AI/tool messages from graph state and persist them. */
export function saveAiMessages(threadId: string, messages: any[]): void {
  // Build a set of message IDs already persisted so we skip re-inserting
  // messages from earlier turns that LangGraph still carries in state.
  const existingIds = new Set(getMessages(threadId).map((m) => m.id));
  const rows: MessageRow[] = [];
  for (const msg of messages) {
    const type = msg.type ?? msg._getType?.();
    // Skip messages that already exist in the DB (from previous turns).
    if (msg.id && existingIds.has(msg.id)) continue;
    if (type === "ai" || type === "AIMessage") {
      // Persist reasoning_content (additional_kwargs) so the web client can
      // restore the thinking trace after a refresh. Without this, reasoning is
      // only visible during the live stream and lost on reload.
      const reasoningContent = msg.additional_kwargs?.reasoning_content;
      rows.push({
        id: msg.id ?? `msg_${Date.now()}_${rows.length}`,
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        toolCalls: msg.tool_calls ?? undefined,
        extraMetadata: reasoningContent
          ? { additional_kwargs: { reasoning_content: reasoningContent } }
          : undefined,
        createdAt: new Date().toISOString(),
      });
    } else if (type === "tool" || type === "ToolMessage") {
      rows.push({
        id: msg.id ?? `msg_${Date.now()}_${rows.length}`,
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        extraMetadata: {
          tool_call_id: msg.tool_call_id,
          toolName: msg.name ?? "tool",
        },
        createdAt: new Date().toISOString(),
      });
    }
  }
  if (rows.length > 0) {
    addMessages(threadId, rows);
  }
}

/**
 * Persist partial assistant output when the client disconnects mid-stream
 * (user clicked stop) or the stream errors out. @returns true if saved.
 */
export function savePartialAssistantMessage(
  threadId: string,
  accumulatedContent: string,
  requestId: string,
): boolean {
  if (!accumulatedContent) return false;
  addMessage(threadId, {
    id: `msg_${Date.now()}`,
    role: "assistant",
    content: accumulatedContent,
    extraMetadata: {
      error_type: "interrupted",
      is_error: true,
      error_message: "对话已中断",
      request_id: requestId,
    },
    createdAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Stamp the finished turn's work duration (ms since run start) onto the
 * thread's LAST assistant message's extraMetadata (`work_duration_ms`), so
 * history reloads can render the frozen "已工作 Xm" indicator. Also returns
 * the duration so the `finished` chunk can carry it in meta.
 */
export function stampWorkDuration(
  threadId: string,
  startedAt: number | undefined,
): number | undefined {
  if (!startedAt) return undefined;
  const duration = Date.now() - startedAt;
  const last = [...getMessages(threadId)].reverse().find((m) => m.role === "assistant");
  if (last) {
    mergeMessageExtra(threadId, last.id, { work_duration_ms: duration });
  }
  return duration;
}

// =============================================================================
// HITL interrupt helpers (moved from chat.ts)
// =============================================================================

/** Extract the first interrupt info from a LangGraph state snapshot. */
export function extractInterruptInfo(state: any): any | null {
  if (state?.tasks && Array.isArray(state.tasks)) {
    for (const task of state.tasks) {
      if (task.interrupts && task.interrupts.length > 0) {
        return task.interrupts[0];
      }
    }
  }
  const values = state?.values ?? state ?? {};
  const interruptData = values.__interrupt__;
  if (Array.isArray(interruptData) && interruptData.length > 0) {
    return interruptData[0];
  }
  return null;
}

/** Count the number of interrupted action requests in an interrupt info. */
export function countInterruptedActions(interruptInfo: any): number {
  const value = interruptInfo?.value ?? interruptInfo;
  if (value && typeof value === "object") {
    const requests = value.actionRequests;
    if (Array.isArray(requests) && requests.length > 0) {
      return requests.length;
    }
  }
  return 1;
}

/**
 * Build the `ask_user_question_required` payload from an interrupt.
 *
 * Three `kind`:
 *   - tool_approval : LangChain humanInTheLoopMiddleware interrupt. The
 *     interrupt value carries `actionRequests` + `reviewConfigs`. We surface
 *     one question per actionRequest so the user can decide each tool
 *     independently (the old code applied one decision to all actions — a bug
 *     when multiple tools were batched). Options are derived from
 *     `reviewConfigs[].allowedDecisions` (approve/reject/edit), not hardcoded.
 *   - discussion / clarify : the agent's `ask_user_question` tool set
 *     `interrupt.value = { kind, questions: [...] }`. The questions already
 *     carry stable `question_id`s (assigned by the tool), so we pass them
 *     through verbatim — never regenerate ids, or resume can't pair answers.
 *
 * Discriminant priority: `value.kind` > has `actionRequests` → tool_approval
 * > has `options` → discussion > else clarify.
 */
export function buildAskPayload(
  interruptInfo: any,
  threadId: string,
): AskUserQuestionPayload {
  const value = interruptInfo?.value ?? interruptInfo ?? {};

  // --- Plan approval gate (submit_plan tool) ---
  if (value.kind === "plan_approval") {
    return {
      kind: "plan_approval",
      questions: [
        {
          question_id: `plan_${Date.now()}`,
          question: String(value.plan ?? ""),
          header: "计划审批",
        },
      ],
      thread_id: threadId,
    };
  }

  // --- Agent-initiated ask (ask_user_question tool) ---
  if (value.kind === "discussion" || value.kind === "clarify") {
    const questions: AskQuestion[] = Array.isArray(value.questions)
      ? value.questions.map((q: any) => ({
          question_id: String(q.question_id ?? `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          question: String(q.question ?? ""),
          ...(q.header ? { header: String(q.header) } : {}),
          ...(Array.isArray(q.options) ? { options: q.options } : {}),
          ...(typeof q.multi_select === "boolean" ? { multi_select: q.multi_select } : {}),
          ...(typeof q.allow_other === "boolean" ? { allow_other: q.allow_other } : {}),
        }))
      : [];
    return { kind: value.kind, questions, thread_id: threadId };
  }

  // --- Passive tool-call approval (humanInTheLoopMiddleware) ---
  const actionRequests: any[] = Array.isArray(value.actionRequests) ? value.actionRequests : [];
  const reviewConfigs: any[] = Array.isArray(value.reviewConfigs) ? value.reviewConfigs : [];

  if (actionRequests.length === 0) {
    // Defensive: an interrupt with neither kind nor actionRequests. Surface a
    // generic single-question approval so the client always has something to
    // render rather than hanging.
    return {
      kind: "tool_approval",
      questions: [
        {
          question_id: `ta_${uuid()}`,
          question: "工具调用需要批准",
          options: [
            { label: "批准", value: "approve" },
            { label: "拒绝", value: "reject" },
          ],
          context: { source: value.source ?? value.tool_name ?? "interrupt" },
        },
      ],
      thread_id: threadId,
    };
  }

  // One question per actionRequest so the user can decide each tool
  // independently. allowedDecisions come from reviewConfigs (default
  // approve/reject when unspecified); each becomes an option's value.
  const questions: AskQuestion[] = actionRequests.map((req: any, idx: number) => {
    const name = String(req.name ?? "unknown");
    const desc = typeof req.description === "string" ? req.description : undefined;
    const review = reviewConfigs[idx] ?? reviewConfigs.find((r: any) => r.actionName === name);
    const allowed: string[] =
      Array.isArray(review?.allowedDecisions) && review.allowedDecisions.length > 0
        ? review.allowedDecisions
        : ["approve", "reject"];
    const optionLabels: Record<string, string> = {
      approve: "批准",
      reject: "拒绝",
      edit: "编辑后批准",
    };
    return {
      question_id: `ta_${uuid()}`,
      question: desc ?? `批准执行: ${name}?`,
      header: name,
      options: allowed.map((d) => ({ label: optionLabels[d] ?? d, value: d })),
      multi_select: false,
      allow_other: false,
      context: {
        actionRequests: [req],
        source: name,
        reviewConfigs: review ? [review] : undefined,
      },
    };
  });

  return {
    kind: "tool_approval",
    questions,
    thread_id: threadId,
  };
}

/**
 * Normalize a ResumeRequestBody into the langgraph `Command({ resume })` value.
 *
 * - tool_approval → `{ decisions: [...] }` (one per actionRequest, in order).
 *   Legacy `{ approved }` is folded here: true → all approve, false → all reject.
 * - discussion / clarify → `{ answers: [...] }` passed straight through to the
 *   `ask_user_question` tool's `interrupt()` return value.
 */
export function normalizeResumeInput(
  body: ResumeRequestBody,
  actionCount: number,
): { decisions: Array<Record<string, unknown>> } | { answers: ResumeRequestBody["answers"] } | { approved: boolean; feedback?: string } {
  const kind = body.kind ?? (body.decisions ? "tool_approval" : body.answers ? "discussion" : "tool_approval");

  if (kind === "tool_approval") {
    // Pre-built decisions take priority; otherwise fold legacy `approved`.
    if (Array.isArray(body.decisions) && body.decisions.length > 0) {
      return { decisions: body.decisions };
    }
    const approved = body.approved !== false; // default true when unspecified
    const decisionType = approved ? "approve" : "reject";
    return {
      decisions: Array.from({ length: Math.max(actionCount, 1) }, () => ({ type: decisionType })),
    };
  }

  // plan_approval — the submit_plan tool's interrupt() expects
  // { approved, feedback? } as its resume value.
  if (kind === "plan_approval") {
    return { approved: body.approved !== false, feedback: body.feedback };
  }

  // discussion / clarify — answers flow back to the ask_user_question tool.
  return { answers: body.answers ?? [] };
}

/**
 * After streaming, check whether the graph stopped at a HITL interrupt and
 * emit `ask_user_question_required` if so. @returns true if an interrupt is pending.
 */
export async function checkAndHandleInterrupts(
  agent: any,
  langgraphConfig: Record<string, unknown>,
  threadId: string,
  emit: Emit,
): Promise<boolean> {
  try {
    const state = await agent.getState(langgraphConfig);
    if (!state?.values) return false;

    const interruptInfo = extractInterruptInfo(state);
    if (!interruptInfo) return false;

    const payload = buildAskPayload(interruptInfo, threadId);
    logger.info("HITL interrupt detected — emitting ask", {
      thread_id: threadId,
      kind: payload.kind,
      question_count: payload.questions.length,
    });
    emit({
      type: "ask",
      kind: payload.kind,
      questions: payload.questions,
      thread_id: threadId,
    });
    return true;
  } catch (err) {
    logger.exception("Failed to check interrupts", err);
    return false;
  }
}

// =============================================================================
// Stream processing core (shared by chat + resume)
// =============================================================================

/**
 * Translate one standardized AgentEvent into an emit() call and accumulate
 * assistant text for partial-save. Content events pass through verbatim — the
 * engine already emits the typed protocol shape; `seq` is assigned by the
 * route's run-registry wrapper.
 */
function processAgentEvent(
  event: AgentEvent,
  accumulate: (text: string) => void,
  emit: Emit,
): void {
  if (event.type === "text.delta") {
    accumulate(event.delta);
  }
  emit(event);
}

// =============================================================================
// Attachment expansion — build multimodal graph input from attachment refs
// =============================================================================

/** Content blocks the LangGraph Rust checkpointer can deserialize — keep the
 * user message within text + image_url or thread reload 400s (see
 * core's BinaryContentSanitizerMiddleware). */
type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Inline threshold for text-like attachments (bytes). Smaller files are
 * fully inlined into the user message (opencode-style eager expansion);
 * larger ones get a head preview + a read_file pointer. */
const TEXT_INLINE_MAX_BYTES = 100 * 1024;
/** Skip inlining (and skip the image block) beyond this size — providers
 * reject oversized base64 anyway. */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** Extensions treated as extractable text (beyond mime text/* and
 * application/json etc.) — mirrors the client-side whitelist. */
const TEXT_EXTENSIONS = new Set([
  "md", "txt", "markdown", "mdx", "log", "csv", "tsv",
  "json", "jsonc", "yaml", "yml", "toml", "xml", "ini", "env", "properties", "conf",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs",
  "php", "swift", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "html", "htm", "css", "scss", "sass", "less", "svg",
  "dockerfile", "makefile", "gitignore", "gitattributes", "editorconfig",
]);

function extensionOf(name: string): string {
  const base = name.toLowerCase();
  const dot = base.lastIndexOf(".");
  // Extensionless dotfiles (".gitignore") → the whole name IS the extension.
  if (dot <= 0) return base.replace(/^\./, "");
  return base.slice(dot + 1);
}

function isTextLike(name: string, mime?: string): boolean {
  if (mime) {
    if (IMAGE_MIMES.has(mime)) return false;
    if (mime.startsWith("text/")) return true;
    if (/^(application\/(json|xml|yaml|toml|x-sh|x-javascript|typescript))/i.test(mime)) return true;
    if (mime === "application/pdf" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return false;
  }
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

/** Clip text to a preview with a pointer to the full file. Keeps the first
 * ~200 lines; the agent can read_file the rest on demand. */
function clipText(text: string, displayPath: string): string {
  const lines = text.split("\n");
  if (lines.length <= 200) return text;
  return `${lines.slice(0, 200).join("\n")}\n\n...（内容过长已截断，共 ${lines.length} 行；完整内容位于 ${displayPath}，可用 read_file 读取）`;
}

/** Extract plain text from a PDF buffer via unpdf. Returns "" when the PDF
 * has no text layer (e.g. scanned images). */
async function extractPdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text ?? "";
}

/** Extract plain text from a DOCX buffer via mammoth. */
async function extractDocxText(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

/**
 * Expand attachments into user-message content blocks:
 *   images            → image_url (base64 data URL) — the ONLY image channel
 *                       the model can see (read_file image blocks are
 *                       sanitized to placeholders by the checkpointer guard)
 *   text-like files   → inlined (≤100KB) or head-preview + read_file pointer
 *   pdf / docx        → text extracted (unpdf / mammoth), then the size rule
 *   other binaries    → honest path-reference note (agent may still read_file
 *                       them, but content is not parsed)
 *
 * A failure to expand one attachment never fails the turn — it degrades to a
 * note the model can relay to the user.
 */
async function expandAttachments(
  attachments: ResolvedAttachment[],
): Promise<UserContentBlock[]> {
  const blocks: UserContentBlock[] = [];
  for (const att of attachments) {
    try {
      const ext = extensionOf(att.name);
      const mime =
        att.mime && att.mime !== "application/octet-stream"
          ? att.mime
          : att.mime ?? (IMAGE_MIMES.has(`image/${ext}`) ? `image/${ext}` : undefined);
      // 1) Images — sniff by declared mime or image extension.
      const isImage =
        (mime && IMAGE_MIMES.has(mime)) ||
        ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext);
      if (isImage) {
        const { readFile } = await import("node:fs/promises");
        const buf = await readFile(att.absPath);
        if (buf.byteLength > IMAGE_MAX_BYTES) {
          blocks.push({ type: "text", text: `[图片 ${att.name}（${(buf.byteLength / 1048576).toFixed(1)}MB）超过 8MB 限制，未附加；文件位于 ${att.path}]` });
          continue;
        }
        const imageMime = mime && IMAGE_MIMES.has(mime) ? mime : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${imageMime};base64,${buf.toString("base64")}` },
        });
        continue;
      }
      // 2) PDF — extract the text layer.
      if (ext === "pdf" || mime === "application/pdf") {
        const { readFile } = await import("node:fs/promises");
        let text = "";
        try {
          text = await extractPdfText(await readFile(att.absPath));
        } catch (err) {
          logger.exception("PDF text extraction failed", err);
        }
        if (!text.trim()) {
          blocks.push({ type: "text", text: `[附件 ${att.name} 是 PDF 但无法提取文本（可能是扫描件）；文件位于 ${att.path}]` });
        } else {
          blocks.push({ type: "text", text: `[附件 ${att.name}（PDF，已提取文本）]\n${clipText(text, att.path)}` });
        }
        continue;
      }
      // 3) DOCX — extract raw text.
      if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const { readFile } = await import("node:fs/promises");
        let text = "";
        try {
          text = await extractDocxText(await readFile(att.absPath));
        } catch (err) {
          logger.exception("DOCX text extraction failed", err);
        }
        if (!text.trim()) {
          blocks.push({ type: "text", text: `[附件 ${att.name} 是 Word 文档但无法提取文本；文件位于 ${att.path}]` });
        } else {
          blocks.push({ type: "text", text: `[附件 ${att.name}（Word 文档，已提取文本）]\n${clipText(text, att.path)}` });
        }
        continue;
      }
      // 4) Text-like — inline (small) or preview + pointer (large).
      if (isTextLike(att.name, mime)) {
        const { readFile } = await import("node:fs/promises");
        const buf = await readFile(att.absPath);
        if (buf.byteLength <= TEXT_INLINE_MAX_BYTES) {
          blocks.push({ type: "text", text: `[附件 ${att.name} 的内容]\n${buf.toString("utf8")}` });
        } else {
          blocks.push({ type: "text", text: `[附件 ${att.name} 的内容（过长，仅开头部分）]\n${clipText(buf.toString("utf8"), att.path)}` });
        }
        continue;
      }
      // 5) Other binaries — honest reference note.
      blocks.push({ type: "text", text: `[附件 ${att.name}${mime ? `（${mime}）` : ""}位于 ${att.path}，该类型暂不支持内容解析]` });
    } catch (err) {
      logger.exception("Attachment expansion failed", err);
      blocks.push({ type: "text", text: `[附件 ${att.name} 读取失败：${(err as Error).message ?? "未知错误"}]` });
    }
  }
  return blocks;
}

/** Build the graph input content: plain string when there are no attachments
 * (zero behavior change), content blocks otherwise. */
async function buildUserContent(
  userMessage: string,
  attachments?: ResolvedAttachment[],
): Promise<string | UserContentBlock[]> {
  if (!attachments || attachments.length === 0) return userMessage;
  const blocks: UserContentBlock[] = [];
  if (userMessage) blocks.push({ type: "text", text: userMessage });
  blocks.push(...(await expandAttachments(attachments)));
  return blocks;
}

/**
 * Run a fresh chat turn to completion. Handles persistence, HITL, title
 * generation, and client disconnect. The route owns the ReadableStream; this
 * owns everything that happens inside it.
 */
export async function streamChat(
  input: ChatInput,
  emit: Emit,
  abortSignal?: AbortSignal,
): Promise<void> {
  let accumulatedContent = "";
  let clientAborted = false;
  const accumulate = (text: string) => { accumulatedContent += text; };

  try {
    // 1. turn.started
    emit({
      type: "turn.started",
      threadId: input.threadId,
      requestId: input.requestId,
      runStartedAt: input.startedAt ?? Date.now(),
      userMessage: input.userMessage,
      ...(input.attachments && input.attachments.length > 0
        ? {
            attachments: input.attachments.map(({ absPath: _absPath, ...ref }) => ref),
          }
        : {}),
    });

    // 1b. Auto-title a new thread's first turn IN THE BACKGROUND (opencode
    //     semantics: kicked off as the first LLM loop starts, not at turn end,
    //     so the sidebar shows a real title within seconds while the main
    //     model is still streaming). Failures are silent — the title simply
    //     stays "新对话" until the user renames it.
    if (input.isNewThread) {
      // Attachment-only turns have no text — fall back to the first
      // attachment's name so the sidebar shows something meaningful.
      const fallbackTitle = input.userMessage.slice(0, 30) || input.attachments?.[0]?.name.slice(0, 30) || "";
      void (async () => {
        try {
          const titleSeed = input.userMessage || (input.attachments?.length ? `关于附件 ${input.attachments[0].name} 的问题` : "");
          const generated = titleSeed ? await generateTitle(titleSeed, input.modelSpec) : undefined;
          const title = generated ?? fallbackTitle;
          // Lazy import to avoid a circular dep at module load (thread.service is
          // pure db; importing its rename fn here keeps update local to this call).
          const { renameThread } = await import("./thread.service.js");
          renameThread(input.threadId, title);
          logger.info(`Auto-titled thread ${input.threadId}: "${title}"`);
          // Push to live subscribers AND the replayable event log — the sidebar
          // updates without waiting for turn.finished / listThreads() refresh.
          emit({ type: "thread.title.updated", threadId: input.threadId, title });
        } catch (err) {
          logger.exception("Auto title generation failed", err);
        }
      })();
    }

    // 2. Stream graph (via standardized AgentEvent — no LangGraph coupling here)
    try {
      const eventStream = await input.agent.stream(
        { messages: [{ role: "user", content: await buildUserContent(input.userMessage, input.attachments) }] },
        {
          ...input.langgraphConfig,
          streamMode: ["messages" as const],
          ...(abortSignal ? { signal: abortSignal } : {}),
        },
      );

      const agentEvents = wrapAgentStream(eventStream, {
        subagentRegistry: input.subagentRegistry,
      });
      for await (const event of agentEvents) {
        processAgentEvent(event, accumulate, emit);
      }
    } catch (streamErr: any) {
      const isInterrupt =
        streamErr?.name === "GraphInterrupt" ||
        streamErr?.message?.includes?.("interrupt") ||
        streamErr?.constructor?.name === "GraphInterrupt";

      // Subscription model: the graph stream is bound ONLY to the run
      // registry's AbortController (explicit /stop). There is no live HTTP
      // response tied to the run (POST /agent returns 202 immediately), so a
      // "client disconnect" cannot occur here — an AbortError or connection
      // reset at this point is an UPSTREAM failure (provider/proxy timeout)
      // and must surface as turn.error, not be swallowed as a disconnect
      // (swallowing it leaves the durable log without a terminal event, which
      // /events later misreports as the synthetic run_lost restart error).
      if (abortSignal?.aborted) {
        clientAborted = true;
        const saved = savePartialAssistantMessage(input.threadId, accumulatedContent, input.requestId);
        const durationMs = stampWorkDuration(input.threadId, input.startedAt);
        emit({
          type: "turn.interrupted",
          partialSaved: saved,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
        logger.info(`Run aborted by stop request${saved ? " (partial saved)" : ""}`, {
          thread_id: input.threadId,
          request_id: input.requestId,
        });
      } else if (!isInterrupt) {
        const isDeserError =
          streamErr?.message?.includes?.("deserialize") ||
          streamErr?.message?.includes?.("unknown variant") ||
          streamErr?.message?.includes?.("expected `text`");
        if (isDeserError) {
          logger.warn(
            `Legacy deserialization error in thread ${input.threadId} — ` +
              "checkpoint contains content types the backend can't read. " +
              "Start a new thread to clear it.",
            { error: String(streamErr).slice(0, 200) },
          );
        }
        throw streamErr;
      }
      // Interrupt — fall through to check state below.
    }

    // 3. Persist AI messages (skip on abort — partial already saved).
    if (!clientAborted) {
      try {
        const state = await input.agent.getState(input.langgraphConfig);
        const stateMessages = state?.values?.messages ?? [];
        saveAiMessages(input.threadId, stateMessages);
      } catch (err) {
        logger.exception("Failed to save AI messages", err);
      }
    }

    // 4. Check for HITL interrupt
    const hasInterrupt = await checkAndHandleInterrupts(
      input.agent, input.langgraphConfig, input.threadId, emit,
    );

    // 5. Title for a new thread's first turn is generated by the background
    //    task kicked off at turn start (1b above) — the DB is already updated
    //    and a thread.title.updated event was emitted by the time we get here
    //    (or shortly after). No synchronous work needed at turn end.

    // 6. Emit finished. Interrupted turns don't emit finished — the turn
    //    isn't done. Title for new threads arrives via the background
    //    thread.title.updated event (1b), not here.
    //    Stamp the work duration onto the last assistant message first (the
    //    "已工作 Xm" indicator survives history reloads).
    const durationMs = stampWorkDuration(input.threadId, input.startedAt);
    if (!hasInterrupt) {
      emit({
        type: "turn.finished",
        threadId: input.threadId,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  } catch (err) {
    if (abortSignal?.aborted && !clientAborted) {
      // Explicit stop reached the outer loop — persist partial + notify.
      if (accumulatedContent) {
        savePartialAssistantMessage(input.threadId, accumulatedContent, input.requestId);
      }
      const durationMs = stampWorkDuration(input.threadId, input.startedAt);
      emit({
        type: "turn.interrupted",
        partialSaved: accumulatedContent.length > 0,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      logger.info(`Run aborted (outer)`, {
        thread_id: input.threadId,
        request_id: input.requestId,
      });
    } else {
      // Any other failure (including upstream provider aborts/connection
      // resets that isClientDisconnect would have swallowed) must surface as
      // a terminal error — a silent return leaves the durable log without a
      // terminal event and /events later reports a bogus run_lost.
      logger.exception("Agent stream failed", err);
      emit({
        type: "turn.error",
        errorType: "agent_error",
        message: err instanceof Error ? err.message : "未知错误",
        threadId: input.threadId,
      });
    }
  }
}

/**
 * Resume a HITL-interrupted turn. Shares the chunk-translation core with
 * streamChat; differs in entry (Command resume) and has no title generation.
 */
export async function streamResume(
  input: ResumeInput,
  emit: Emit,
  abortSignal?: AbortSignal,
): Promise<void> {
  // Step 1: Read pre-state to count interrupted actions.
  let actionCount = 1;
  try {
    const preState = await input.agent.getState(input.langgraphConfig);
    if (preState) {
      const interruptInfo = extractInterruptInfo(preState);
      if (interruptInfo) {
        actionCount = countInterruptedActions(interruptInfo);
      } else {
        logger.warn("Resume called but no interrupt found in state", {
          thread_id: input.threadId,
        });
      }
    }
  } catch (err) {
    logger.exception("Failed to read pre-state for resume", err);
  }

  // Step 2: Normalize resume input.
  const normalizedResume = normalizeResumeInput(input.resumeBody, actionCount);
  const resumeCommand = new Command({ resume: normalizedResume });
  logger.info("Resume sending", {
    thread_id: input.threadId,
    kind: input.resumeBody.kind ?? "tool_approval",
    resume_keys: Object.keys(normalizedResume),
  });

  try {
    // Resume continues the SAME turn — no synthetic user bubble. The boundary
    // event carries no userMessage; clients render a user bubble only when
    // turn.started.userMessage is present (a fresh turn from POST /agent).
    emit({
      type: "turn.started",
      threadId: input.threadId,
      requestId: input.requestId,
      runStartedAt: input.startedAt ?? Date.now(),
    });

    // Step 3: Stream the resumed graph (standardized AgentEvent).
    try {
      const eventStream = await input.agent.stream(resumeCommand, {
        ...input.langgraphConfig,
        streamMode: ["messages" as const],
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      const agentEvents = wrapAgentStream(eventStream, {
        subagentRegistry: input.subagentRegistry,
      });
      // Resume skips the accumulation/partial-save path (state was already
      // persisted by the interrupt). Use a no-op accumulate.
      for await (const event of agentEvents) {
        processAgentEvent(event, () => {}, emit);
      }
    } catch (streamErr: any) {
      const isInterrupt =
        streamErr?.name === "GraphInterrupt" ||
        streamErr?.message?.includes?.("interrupt") ||
        streamErr?.constructor?.name === "GraphInterrupt";
      // Subscription model: only an explicit /stop (abortSignal.aborted)
      // interrupts here — upstream AbortError/connection resets are real
      // errors and propagate to the outer catch (turn.error), never silent.
      if (abortSignal?.aborted) {
        emit({
          type: "turn.interrupted",
          partialSaved: false,
        });
      } else if (!isInterrupt) throw streamErr;
    }

    // Step 4: Persist AI messages.
    try {
      const state = await input.agent.getState(input.langgraphConfig);
      const stateMessages = state?.values?.messages ?? [];
      saveAiMessages(input.threadId, stateMessages);
    } catch (err) {
      logger.exception("Failed to save AI messages on resume", err);
    }

    // Step 5: Check for nested interrupts.
    const hasInterrupt = await checkAndHandleInterrupts(
      input.agent, input.langgraphConfig, input.threadId, emit,
    );

    if (!hasInterrupt) {
      const durationMs = stampWorkDuration(input.threadId, input.startedAt);
      emit({
        type: "turn.finished",
        threadId: input.threadId,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  } catch (err) {
    logger.exception("Agent stream failed", err);
    emit({
      type: "turn.error",
      errorType: "agent_error",
      message: err instanceof Error ? err.message : "未知错误",
      threadId: input.threadId,
    });
  }
}
