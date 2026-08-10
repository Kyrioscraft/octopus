import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useStickToBottom — "smart follow" scroll behavior for streaming UIs.
 *
 * Tracks whether the user is currently pinned to the bottom of a scroll
 * container. Auto-follows new content only while stuck; once the user scrolls
 * up, the view stays put until they manually scroll back to the bottom.
 *
 * Why a ref + state split:
 *  - `stickRef` is read inside streaming callbacks (which close over a stale
 *    snapshot of state). A ref always holds the latest value.
 *  - `isStuck` state drives UI (e.g. a "back to bottom" button) and only
 *    re-renders on threshold crossings, not on every scroll pixel.
 */
const THRESHOLD = 80; // within 80px of the bottom counts as "stuck"

export interface ScrollToBottomOpts {
  /** Bypass the stuck check and always scroll (e.g. user sent a message). */
  force?: boolean;
  /** Use smooth animation (e.g. button click). Streaming defaults to instant. */
  smooth?: boolean;
}

export function useStickToBottom() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Latest stick state for streaming callbacks (never stale).
  const stickRef = useRef(true);
  // Stick state for rendering (only updated on threshold crossings).
  const [isStuck, setIsStuck] = useState(true);
  // Mirror so the scroll listener (registered once) reads the latest setter.
  const setIsStuckRef = useRef(setIsStuck);
  setIsStuckRef.current = setIsStuck;

  // rAF throttle flag so multiple chunks in the same frame coalesce.
  const rafScheduled = useRef(false);

  // Attach a passive scroll listener once the container mounts.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const compute = () => {
      const stuck =
        el.scrollTop + el.clientHeight >= el.scrollHeight - THRESHOLD;
      if (stickRef.current !== stuck) {
        stickRef.current = stuck;
        setIsStuckRef.current(stuck);
      }
    };

    compute(); // sync initial state (in case content already overflows)
    el.addEventListener("scroll", compute, { passive: true });
    return () => el.removeEventListener("scroll", compute);
  }, []);

  const scrollToBottom = useCallback((opts?: ScrollToBottomOpts) => {
    const { force = false, smooth = false } = opts ?? {};
    const el = scrollContainerRef.current;
    if (!el) return;
    // When not forcing, respect the user's scroll position.
    if (!force && !stickRef.current) return;

    const target = el.scrollHeight - el.clientHeight;
    // For streaming (instant), set scrollTop directly to avoid animation
    // stacking under high-frequency chunks. For button clicks, use smooth.
    if (smooth) {
      el.scrollTo({ top: target, behavior: "smooth" });
    } else {
      // Coalesce multiple same-frame calls via rAF.
      if (rafScheduled.current) return;
      rafScheduled.current = true;
      requestAnimationFrame(() => {
        rafScheduled.current = false;
        const e = scrollContainerRef.current;
        if (!e) return;
        e.scrollTop = e.scrollHeight - e.clientHeight;
        // We just forced the bottom; mark as stuck so subsequent streaming
        // chunks continue to follow without waiting for a scroll event.
        if (stickRef.current !== true) {
          stickRef.current = true;
          setIsStuckRef.current(true);
        }
      });
    }
    // After an explicit scroll-to-bottom, we are stuck again.
    if (!stickRef.current) {
      stickRef.current = true;
      setIsStuckRef.current(true);
    }
  }, []);

  return { scrollContainerRef, isStuck, scrollToBottom };
}
