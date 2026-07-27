import { create } from "zustand";

/**
 * Theme store — drives app-wide light/dark theming.
 *
 * Three modes:
 *   - `light`  : force light
 *   - `dark`   : force dark
 *   - `system` : follow the OS preference via `prefers-color-scheme`, updating
 *                live when the user changes their system theme.
 *
 * The *resolved* value (`'light' | 'dark'`) is what actually gets applied —
 * it is written to `<html data-theme="...">` so CSS (`[data-theme="dark"]`)
 * and antd's `darkAlgorithm` (read from `useThemeStore(s => s.resolved)`)
 * both react to it.
 *
 * Persistence follows the project convention (see `chat.ts`): manual
 * `localStorage`, no zustand `persist` middleware. Key: `octopus.theme-mode`.
 *
 * `initTheme()` is called once at app entry (`main.tsx`) **before** React
 * renders, so the correct `data-theme` is set synchronously and there is no
 * first-paint flash of the wrong theme.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "octopus.theme-mode";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

interface ThemeState {
  /** The user's chosen mode (what the settings UI shows). */
  mode: ThemeMode;
  /** The actual theme in effect (`system` resolved to light/dark). */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MEDIA_QUERY).matches;
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolved;
}

/**
 * Resolve + apply the theme synchronously. Called once at app entry before
 * React renders (prevents first-paint flash). Safe to call multiple times.
 */
export function initTheme(): void {
  const mode = readStoredMode();
  applyTheme(resolveTheme(mode));
}

// --- Live system-theme tracking for `system` mode --------------------------
// We keep a single matchMedia listener; it only mutates state when the active
// mode is `system`, so light/dark users are unaffected by OS changes.
if (typeof window !== "undefined" && window.matchMedia) {
  const mql = window.matchMedia(MEDIA_QUERY);
  const onChange = () => {
    const { mode } = useThemeStore.getState();
    if (mode !== "system") return; // only `system` mode reacts to OS changes
    const resolved: ResolvedTheme = mql.matches ? "dark" : "light";
    applyTheme(resolved);
    useThemeStore.setState({ resolved });
  };
  // addEventListener is supported on all evergreen browsers; remove the
  // deprecated addListener fallback.
  mql.addEventListener("change", onChange);
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readStoredMode(),
  // Resolve once on store creation and apply immediately — covers the case
  // where initTheme() ran before the store was imported.
  resolved: (() => {
    const resolved = resolveTheme(readStoredMode());
    applyTheme(resolved);
    return resolved;
  })(),
  setMode: (mode) => {
    try {
      if (mode === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore storage errors */
    }
    const resolved = resolveTheme(mode);
    applyTheme(resolved);
    set({ mode, resolved });
  },
}));
