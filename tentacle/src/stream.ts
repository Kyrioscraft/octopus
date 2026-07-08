import type { StreamEvent } from "./types.js";

// =============================================================================
// NDJSON stream parser
//
// Reads a `ReadableStream<Uint8Array>` line-by-line and yields parsed
// `StreamEvent` objects. Designed for the Octopus chat protocol:
//
//   - Wire format: one JSON object per line, separated by `\n` (1 byte of
//     overhead per frame — smaller than SSE's `data: \n\n` and WebSocket's
//     2-6 byte frame header).
//   - Backpressure is pull-based: this generator only `reader.read()`s when
//     the consumer awaits the next `for await`. The browser/network stack
//     then applies TCP flow control back to the server — there's no risk of
//     an unbounded buffer building up if the consumer is slow (e.g. when
//     rendering markdown incrementally).
//   - Supports an optional `AbortSignal`: when aborted, the generator stops
//     early and releases the reader lock. The caller is responsible for
//     aborting the underlying `fetch()` (the client wrapper handles that).
//
// Robustness notes:
//   - Chunks can arrive mid-line (TCP doesn't honor `\n` boundaries). The
//     buffer accumulates partial bytes and only emits on a full `\n`.
//   - A single network read can carry multiple lines (server may batch). We
//     `split("\n")` and emit every complete line, keeping the trailing
//     fragment in the buffer for the next read.
//   - `TextDecoder` is fed `{stream: true}` so multi-byte UTF-8 sequences
//     split across reads decode correctly.
//   - Malformed lines are skipped silently — the server occasionally emits
//     a trailing newline or partial frame on disconnect.
// =============================================================================

export interface ParseOptions {
  /**
   * Abort the parser early. When the signal fires the generator stops and
   * the underlying reader is cancelled (best-effort). Note this does NOT
   * cancel the underlying fetch by itself — pass the same signal to
   * `fetch()` too (the client wrapper does this).
   */
  signal?: AbortSignal;
}

/**
 * Parse an NDJSON response stream into an async iterable of `StreamEvent`s.
 *
 * Usage:
 * ```ts
 * const response = await fetch("/api/chat/agent", { ... });
 * for await (const event of parseNDJSONStream(response.body!)) {
 *   switch (event.status) {
 *     case "loading": console.log(event.response); break;
 *     case "finished": console.log("done"); break;
 *   }
 * }
 * ```
 */
export async function* parseNDJSONStream(
  readable: ReadableStream<Uint8Array>,
  opts: ParseOptions = {}
): AsyncGenerator<StreamEvent> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // When the signal aborts, cancel the reader so the underlying stream is
  // released promptly. We do this via listener + a checked flag; the
  // `finally` block removes the listener and releases the lock.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      // Cooperative cancellation point: an abort between reads also unblocks.
      if (aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines; emit complete lines, keep partial line in buffer.
      // `pop()` removes the last element (the trailing fragment, which may be
      // "" if the chunk ended on a `\n`) and leaves only complete lines.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as StreamEvent;
        } catch {
          // Skip malformed lines (partial frame / trailing garbage).
        }
      }
    }

    // Flush remaining buffer (handles a final line without trailing `\n`).
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer.trim()) as StreamEvent;
      } catch {
        /* skip */
      }
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released (e.g. by cancel() on abort) — ignore.
    }
  }
}
