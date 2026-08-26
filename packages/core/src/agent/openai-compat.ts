/**
 * OpenAI-compatible client hardening — GLM (and some other OpenAI-compatible
 * proxies, e.g. newapi relays) mis-serialize PARALLEL tool calls in streaming:
 *
 *  1. Two calls' argument deltas share one streaming index → upstream chunk
 *     accumulators concatenate them (`{"file_path":"a"}{"file_path":"b"}`)
 *     → "Malformed args" → invalid_tool_calls with empty-args fallbacks.
 *  2. A call's header (id+name) lands on another index while its args go to
 *     a sibling's index → an independent empty-args tool call.
 *
 * STRATEGY NOTE: we intentionally do NOT repair attribution at the raw-delta
 * level. The `tool_calls[].index` namespace legally resets per assistant
 * message, and GLM (a) restarts at 0 for every message AND (b) reuses indices
 * mid-message when it corrupts — the two are indistinguishable without
 * message-boundary signals the chunk layer cannot see (role deltas are not
 * reliably emitted). Delta-level heuristics therefore misattributed healthy
 * streams. Instead, ALL streaming paths through this class converge on
 * `_generate`'s return value, where we repair the FINALIZED message:
 * invalid_tool_calls whose raw args are concatenated JSON objects get split
 * back into valid tool_calls, and empty-args duplicates are dropped when a
 * same-name sibling carries the real args.
 *
 * See langchainjs#9237 for the same symptom reported against Qwen (open).
 * For spec-compliant endpoints (real OpenAI, deepseek) the repair is a no-op.
 */

import { ChatOpenAI, ChatOpenAICompletions, convertMessagesToCompletionsMessageParams } from "@langchain/openai";
import { convertOpenAICompletionsStream } from "@langchain/core/language_models/openai_completions_stream";
import { getLogger } from "../logging.js";

const logger = getLogger("agent.openai-compat");

/**
 * True when `s` is a syntactically complete top-level JSON object (balanced
 * braces honoring string/escape nesting).
 */
function _isCompleteJsonObject(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (const ch of t) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inStr) escaped = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    else if (!inStr) {
      if (ch === "{") depth++;
      else if ( ch === "}") {
        depth--;
        if (depth === 0) return true;
      }
    }
  }
  return false;
}

/**
 * Split a string of back-to-back JSON objects into parsed objects.
 * Returns null when the string is not two or more concatenated objects.
 */
function _splitJsonObjects(s: string): Record<string, any>[] | null {
  const t = s.trim();
  if (!t.startsWith("{")) return null;
  const parts: Record<string, any>[] = [];
  let i = 0;
  while (i < t.length) {
    if (t[i] !== "{") return null;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        if (inStr) escaped = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      else if (!inStr) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
    }
    if (end === -1) return null;
    try {
      parts.push(JSON.parse(t.slice(i, end + 1)));
    } catch {
      return null;
    }
    i = end + 1;
    while (i < t.length && /\s/.test(t[i])) i++;
  }
  return parts.length > 1 ? parts : null;
}

/**
 * Repair a FINALIZED assistant message in place:
 *
 *  A. invalid_tool_calls whose raw args parse as 2+ concatenated JSON objects
 *     are split back into valid tool_calls (ids suffixed to stay unique).
 *  B. tool_calls entries whose string args are likewise concatenated are
 *     split (non-streaming corruption shape).
 *  C. empty-args tool calls are dropped when a same-name sibling carries the
 *     real args (corruption mode 2).
 */
function _repairFinalMessage(message: any): void {
  if (!message) return;
  let repaired = 0;

  // --- Phase 1a: split concatenated args on invalid_tool_calls ---
  if (Array.isArray(message.invalid_tool_calls) && message.invalid_tool_calls.length > 0) {
    const remaining: any[] = [];
    for (const bad of message.invalid_tool_calls) {
      const raw = typeof bad.args === "string" ? bad.args : undefined;
      const parts = raw ? _splitJsonObjects(raw) : null;
      if (!parts) {
        remaining.push(bad);
        continue;
      }
      parts.forEach((obj, i) => {
        (message.tool_calls ??= []).push({
          id: i === 0 ? (bad.id ?? `call_fix_${i}`) : `${bad.id ?? "call"}_f${i}`,
          name: bad.name,
          args: obj,
        });
      });
      repaired += parts.length;
    }
    message.invalid_tool_calls = remaining;
  }

  // --- Phase 1b: split concatenated string args on tool_calls ---
  if (Array.isArray(message.tool_calls)) {
    const out: any[] = [];
    for (const tc of message.tool_calls) {
      const raw = typeof tc.args === "string" ? tc.args : undefined;
      const parts = raw ? _splitJsonObjects(raw) : null;
      if (!parts) {
        out.push(tc);
        continue;
      }
      parts.forEach((obj, i) => {
        out.push({
          id: i === 0 ? (tc.id ?? `call_fix_${i}`) : `${tc.id ?? "call"}_f${i}`,
          name: tc.name,
          args: obj,
        });
      });
      repaired += parts.length;
    }
    message.tool_calls = out;
  }

  // --- Phase 2: drop empty-args duplicates when siblings carry real args ---
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const namesWithArgs = new Set(
      message.tool_calls
        .filter(
          (t: any) => t.args && typeof t.args === "object" && Object.keys(t.args).length > 0,
        )
        .map((t: any) => t.name),
    );
    const before = message.tool_calls.length;
    message.tool_calls = message.tool_calls.filter(
      (t: any) =>
        !(
          (t.args == null ||
            (typeof t.args === "object" && Object.keys(t.args).length === 0)) &&
          namesWithArgs.has(t.name)
        ),
    );
    if (message.tool_calls.length < before) {
      logger.debug(
        `Dropped ${before - message.tool_calls.length} empty-args duplicate tool call(s)`,
      );
    }
  }

  if (repaired > 0) {
    logger.info(
      `Repaired ${repaired} tool-call arg(s) from concatenated JSON (endpoint streaming bug)`,
    );
  }
}

/**
 * Delta-level attribution repairer for the native stream-events path, where
 * raw SSE chunks (including finish_reason) are visible. State resets at every
 * message boundary (finish_reason present), making the "index reuse" heuristi­
 * cs sound: within one message, args arriving on an index whose buffer is
 * already a complete JSON object (delta without id/name), or a header delta
 * with a different id on an index that already carries args, means the
 * endpoint interleaved a NEW call on a reused index.
 */
class StreamAttributionRepairer {
  private _states = new Map<number, { id?: string; name?: string; args: string }>();
  /** wire index → active logical index (set when a reused wire index is
   *  reassigned; subsequent args-only deltas on the wire index follow it). */
  private _route = new Map<number, number>();
  private _nextSynthetic = 1000;
  private _repaired = 0;

  reset(): void {
    this._states.clear();
    this._route.clear();
    this._repaired = 0;
  }

  /** Rewrite index/id/name on one raw chunk's tool_calls, in place. */
  repairChunk(data: any): void {
    const choice = data?.choices?.[0];
    if (!choice) return;
    // Message boundary → index namespace resets legally.
    if (choice.finish_reason != null) {
      this.reset();
      return;
    }
    const toolCalls = choice.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    this.repairDeltas(toolCalls);
  }

  /** Rewrite index/id/name on an extracted tool_calls delta array. */
  repairDeltas(toolCalls: any[]): void {
    if (process.env.OCTOPUS_TOOL_TRACE === "1") {
      for (const tc of toolCalls) {
        logger.info(
          `[compat-trace] idx=${tc?.index} id=${tc?.id ?? "-"} ` +
            `name=${tc?.function?.name ?? "-"} args=${JSON.stringify(tc?.function?.arguments ?? "")}`,
        );
      }
    }
    for (const tc of toolCalls) {
      if (tc?.index === undefined) continue;
      // Follow an existing reassignment: args-only deltas keep arriving on
      // the (reused) wire index after we moved the logical call elsewhere.
      const wireIndex = tc.index;
      if (!tc.id && !tc.function?.name) {
        const routed = this._route.get(wireIndex);
        if (routed !== undefined) tc.index = routed;
      }
      let st = this._states.get(tc.index);
      const argDelta = tc.function?.arguments ?? "";
      if (!st) {
        st = { args: "" };
        this._states.set(tc.index, st);
      }
      const idMismatch =
        !!tc.id && !!st.id && tc.id !== st.id && st.args.trim() !== "";
      const headerReuse =
        (!!tc.id || !!tc.function?.name) && st.args.trim() !== "" && tc.id !== st.id;
      const argsAfterComplete =
        !!argDelta && !tc.id && !tc.function?.name && _isCompleteJsonObject(st.args);
      if (idMismatch || headerReuse || argsAfterComplete) {
        // The endpoint started a NEW call on a reused index. Downstream
        // chunk grouping keys on (id AND index) — args-only deltas carry no
        // id, so the new call MUST move to a FRESH index (staying on the
        // reused one would concatenate both calls' args again downstream).
        const oldSlot = this._nextSynthetic++;
        this._states.set(oldSlot, st); // preserve the finished call
        const fresh = { args: argDelta } as { id?: string; name?: string; args: string };
        const newIdx = this._nextSynthetic++;
        fresh.id = tc.id ?? `call_fix_${newIdx}`;
        fresh.name = tc.function?.name ?? st.name;
        tc.index = newIdx;
        if (fresh.id) tc.id = fresh.id;
        if (fresh.name && tc.function) tc.function.name = fresh.name;
        this._states.set(newIdx, fresh);
        // The reused wire index now routes to the new logical index.
        this._route.set(wireIndex, newIdx);
        this._repaired++;
        continue;
      }
      if (tc.id && !st.id) st.id = tc.id;
      if (tc.function?.name && !st.name) st.name = tc.function.name;
      st.args += argDelta;
    }
  }

  flushSummary(): void {
    if (this._repaired > 0) {
      logger.info(
        `Repaired ${this._repaired} streaming tool-call attribution delta(s) ` +
          `(endpoint reused index within message)`,
      );
      this._repaired = 0;
    }
  }
}

/**
 * Completions backend with finalized-message tool-call repair.
 *
 * Agent streaming (langgraph's StreamProtocolMessagesHandler sets
 * `lc_prefer_chat_model_stream_events`) routes model calls through
 * `_streamChatModelEvents`, whose native event assembly bypasses `_generate`.
 * Both paths are covered: the native path wraps the raw SSE stream with a
 * per-message attribution repairer (message boundaries ARE visible here via
 * finish_reason), and `_generate` repairs the finalized message for every
 * other path (invoke, chunk-stream aggregation).
 */
class ChatOpenAICompatibleCompletions extends ChatOpenAICompletions {
  async _generate(messages: any[], options: any, runManager?: any): Promise<any> {
    const res = await super._generate(messages, options, runManager);
    try {
      for (const gen of res?.generations ?? []) {
        const g = Array.isArray(gen) ? gen[0] : gen;
        _repairFinalMessage(g?.message);
      }
    } catch (err) {
      // Repair must never break the model call
      logger.exception("tool-call repair failed", err);
    }
    return res;
  }

  /**
   * Chunk-path repair via the officially overridable conversion hook. The
   * hook receives the FULL raw chunk (`rawResponse.choices[0].finish_reason`),
   * so message boundaries — where the tool-call index namespace legally
   * resets — are visible and the per-message repairer state is sound.
   */
  private _hookRepairer = new StreamAttributionRepairer();

  protected _convertCompletionsDeltaToBaseMessageChunk(
    delta: any,
    rawResponse: any,
    defaultRole?: any,
  ): any {
    const toolCalls = delta?.tool_calls;
    const finishReason = rawResponse?.choices?.[0]?.finish_reason;
    if (finishReason != null) {
      this._hookRepairer.reset();
    }
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      try {
        this._hookRepairer.repairDeltas(toolCalls);
        this._hookRepairer.flushSummary();
      } catch (err) {
        logger.exception("tool-call attribution repair failed", err);
      }
    }
    return super._convertCompletionsDeltaToBaseMessageChunk(
      delta,
      rawResponse,
      defaultRole,
    );
  }

  async *_streamChatModelEvents(
    messages: any[],
    options: any,
    _runManager?: any,
  ): AsyncGenerator<any> {
    const messagesMapped = convertMessagesToCompletionsMessageParams({
      messages,
      model: this.model,
    });
    const params = {
      ...this.invocationParams(options, { streaming: true }),
      messages: messagesMapped,
    };
    const streamIterable = await this.completionWithRetry(
      { ...params, stream: true } as any,
      options,
    );
    // Generator-local repairer → per-stream state, reset at every message
    // boundary (finish_reason), no cross-request leak.
    const repairer = new StreamAttributionRepairer();
    const repairedSource = async function* (source: AsyncIterable<any>) {
      for await (const data of source) {
        try {
          repairer.repairChunk(data);
        } catch (err) {
          logger.exception("stream tool-call attribution repair failed", err);
        }
        yield data;
      }
      repairer.flushSummary();
    };
    yield* convertOpenAICompletionsStream(
      repairedSource(streamIterable),
      {
        streamUsage: this.streamUsage ?? options.streamUsage ?? true,
        provider: this.streamEventProvider,
      },
    );
  }
}

/**
 * Drop-in replacement for `ChatOpenAI` that routes the completions API
 * through {@link ChatOpenAICompatibleCompletions} — use for every
 * OpenAI-compatible endpoint (harmless for spec-compliant ones).
 */
export class ChatOpenAICompatible extends ChatOpenAI {
  private _fields: Record<string, unknown>;
  constructor(fields: Record<string, unknown> = {}) {
    super(fields as any);
    this._fields = fields;
    this.completions = new ChatOpenAICompatibleCompletions(fields as any);
  }
  /**
   * CRITICAL: upstream ChatOpenAI.withConfig does `new ChatOpenAI(this.fields)`
   * — a NATIVE instance that silently drops our completions backend (and the
   * repair with it). bindTools() calls withConfig() internally, so every
   * tool-bound call would bypass the hardening. Re-create a
   * ChatOpenAICompatible here instead.
   */
  override withConfig(config: any) {
    const newModel = new ChatOpenAICompatible(this._fields);
    newModel.defaultOptions = {
      ...this.defaultOptions,
      ...config,
    };
    return newModel;
  }
}
