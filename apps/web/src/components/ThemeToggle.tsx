import { useId, useState } from 'react';
import { applyTheme, currentTheme, type Theme } from './theme';

const OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Theme selector. A native `<select>` with a visible label: it has an accessible name, works with
 * the keyboard (Tab, arrows, Enter/Space) and with screen readers without custom ARIA.
 */
export function ThemeToggle() {
  const id = useId();
  const [theme, setTheme] = useState<Theme>(currentTheme);
  return (
    <span className="theme-toggle">
      <label htmlFor={id}>Theme</label>
      <select
        id={id}
        value={theme}
        onChange={(e) => {
          const next = e.target.value as Theme;
          applyTheme(next);
          setTheme(next);
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}
