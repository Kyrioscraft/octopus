// =============================================================================
// Shared animation frame — single interval drives all spinners.
// Avoids N independent setInterval callbacks overwhelming Ink's render loop.
// =============================================================================

import { useState, useEffect } from "react";
import React from "react";
import { Text } from "ink";

/** Update interval in ms — 300ms keeps the spinner visible while cutting
 *  repaint frequency vs. 200ms (fewer active-region redraws per second
 *  means less scrollback churn and a calmer viewport during streaming). */
const FRAME_INTERVAL = 300;

let frameIndex = 0;
const listeners = new Set<() => void>();

// Start the shared timer on first import
let started = false;
function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    frameIndex++;
    listeners.forEach((fn) => {
      try { fn(); } catch { /* ignore */ }
    });
  }, FRAME_INTERVAL);
}

/**
 * Returns the current spinner frame character. All components share the same
 * animation cycle — only ONE setInterval in the entire app.
 */
export function useFrame(): string {
  const [frame, setFrame] = useState(() => frameIndex);

  useEffect(() => {
    start();
    const listener = () => setFrame(frameIndex);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  return getFrame(frame);
}

// =============================================================================
// Spinner component — a leaf node that consumes useFrame() and renders the
// animated glyph. MUST be used instead of calling useFrame() directly inside
// mid-level components. Because the spinner's state lives in this leaf,
// the 300ms animation tick only re-renders this single <Text>, never the
// parent tree — preventing the flicker/height-jitter that occurs when a
// parent component re-renders on every frame.
// =============================================================================

export const Spinner: React.FC<{ color?: string }> = React.memo(({ color }) => {
  const frame = useFrame();
  return React.createElement(Text, { color }, frame);
});
Spinner.displayName = "Spinner";

// =============================================================================
// Frame glyphs — light braille spinner
// =============================================================================

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getFrame(index: number): string {
  return FRAMES[index % FRAMES.length]!;
}
