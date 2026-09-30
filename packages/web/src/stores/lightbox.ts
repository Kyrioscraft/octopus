import { create } from "zustand";

/**
 * Image lightbox store — one global full-screen viewer for every image in the
 * app (composer attachments, message attachments, markdown images).
 *
 * Kept deliberately tiny: the viewer is mounted once by AppLayout and reads this
 * store, so any component can open an image without threading props or portals
 * through the tree (the previous behaviour was `window.open`, which left the app
 * and lost all context).
 */
interface LightboxState {
  /** Image URL currently shown, or null when the viewer is closed. */
  src: string | null;
  /** Optional caption. */
  alt?: string;
  /** When set, the viewer offers a download action under this file name. */
  downloadName?: string;
  open: (src: string, opts?: { alt?: string; downloadName?: string }) => void;
  close: () => void;
}

export const useLightboxStore = create<LightboxState>((set) => ({
  src: null,
  open: (src, opts) => set({ src, alt: opts?.alt, downloadName: opts?.downloadName }),
  close: () => set({ src: null, alt: undefined, downloadName: undefined }),
}));

/** Convenience for click handlers. */
export function openImage(src: string, opts?: { alt?: string; downloadName?: string }): void {
  useLightboxStore.getState().open(src, opts);
}