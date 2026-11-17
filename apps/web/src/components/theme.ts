/**
 * Appearance policy (objective.md AT-2).
 *
 * - Choices: 'system' (default), 'light', 'dark'.
 * - With no stored choice the app follows the operating system: `<html>` carries no `data-theme`
 *   and the `prefers-color-scheme` media query in styles.css decides. The OS is not tracked in JS.
 * - An explicit choice is written to `<html data-theme="light|dark">` and persisted in
 *   localStorage under `atlas.theme`; choosing 'system' removes both.
 * - Storage may be unavailable (private mode, blocked cookies, quota): every access is guarded, the
 *   app keeps working and the choice simply lasts for the current page only.
 * - `initTheme()` runs in main.tsx before React renders, so a reload paints the chosen theme first.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'atlas.theme';

export function readStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the theme to the document and tries to persist it. Returns whether it was persisted. */
export function applyTheme(theme: Theme): boolean {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function initTheme(): Theme {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
}

/** The theme currently applied to the document (what a fresh ThemeToggle should show). */
export function currentTheme(): Theme {
  const v = document.documentElement.getAttribute('data-theme');
  return v === 'light' || v === 'dark' ? v : readStoredTheme();
}
