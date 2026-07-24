/**
 * Appearance: follow the system, or override it.
 *
 * Default is 'system'. Atlas should look like the rest of the machine it is
 * running on without being asked — but the override exists because a person
 * reading numbers at night may well want a different answer from the one their
 * OS gives, and taking that choice away is not "opinionated", just rigid.
 *
 * The chosen theme is written to <html data-theme>, which the stylesheet reads.
 * 'system' removes the attribute entirely so the prefers-color-scheme media
 * query takes over — rather than us trying to track the OS in JavaScript.
 */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'atlas.theme';

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    localStorage.removeItem(KEY);
  } else {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
  }
}

/**
 * Applied before React renders, so the first paint is already the right
 * colour. Doing it in a component would flash the light theme first.
 */
export function initTheme(): void {
  applyTheme(getTheme());
}
