// =============================================================================
// useTextBuffer — rAF-throttled token buffer for smooth streaming text.
// Equivalent to tui-solution.md §7.1.
//
// Problem:  LLM streaming can produce 50–100 tokens/second. Calling setState
//           on every token causes excessive re-renders, blocking the Node event
//           loop and causing terminal flicker.
//
// Solution: Buffer incoming tokens and flush once per animation frame.
//           This guarantees at most 60 re-renders per second, with only one
//           state update per frame regardless of token rate.
// =============================================================================

import { useRef, useEffect, useCallback } from "react";
import type { BlockId } from "../types.js";

/**
 * Polyfill for requestAnimationFrame in Node.js environments.
 * Modern Node (v18+) has global requestAnimationFrame, but types
 * from @types/node may not include it. Fall back to setTimeout.
 */
function requestAnimFrame(cb: () => void): ReturnType<typeof setTimeout> {
  const g = globalThis as Record<string, unknown>;
  if (typeof g["requestAnimationFrame"] === "function") {
    return (g["requestAnimationFrame"] as (cb: () => void) => number)(cb) as unknown as ReturnType<typeof setTimeout>;
  }
  return setTimeout(cb, 16); // ~60fps
}

function cancelAnimFrame(handle: ReturnType<typeof setTimeout> | null): void {
  if (handle === null) return;
  const g = globalThis as Record<string, unknown>;
  if (typeof g["cancelAnimationFrame"] === "function") {
    (g["cancelAnimationFrame"] as (id: number) => void)(handle as unknown as number);
  } else {
    clearTimeout(handle);
  }
}

/**
 * Hook that returns a `push` function. Call `push(id, token)` for each
 * streaming token. The tokens are batched and flushed once per animation frame
 * via `onFlush(updates)`.
 *
 * @param onFlush - Called with a Map of blockId → concatenated new tokens
 *                  that arrived since the last flush.
 */
export function useTextBuffer(
  onFlush: (updates: Map<BlockId, string>) => void,
) {
  // Buffer: blockId → array of token fragments
  const buffer = useRef<Map<BlockId, string[]>>(new Map());
  // Pending rAF handle
  const rafId = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref to the onFlush callback so we don't re-register on every render
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  /**
   * Flush all buffered tokens.
   * Called from the animation frame callback — builds the update map and invokes onFlush.
   */
  const flush = useCallback(() => {
    rafId.current = null;

    const updates = new Map<BlockId, string>();
    for (const [id, tokens] of buffer.current) {
      updates.set(id, tokens.join(""));
    }
    buffer.current.clear();

    if (updates.size > 0) {
      onFlushRef.current(updates);
    }
  }, []);

  /**
   * Push a token fragment for a block.
   * If no animation frame is pending, registers one.
   */
  const push = useCallback((id: BlockId, token: string) => {
    if (!buffer.current.has(id)) {
      buffer.current.set(id, []);
    }
    buffer.current.get(id)!.push(token);

    // Avoid registering multiple callbacks — only one pending at a time.
    if (rafId.current === null) {
      rafId.current = requestAnimFrame(() => {
        flush();
      });
    }
  }, [flush]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimFrame(rafId.current);
    };
  }, []);

  return { push, flush };
}
