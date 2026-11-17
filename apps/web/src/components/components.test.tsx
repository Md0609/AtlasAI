// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';
import { ThemeToggle } from './ThemeToggle';
import { TOAST_DURATION_MS, ToastProvider, useToast } from './Toast';
import { initTheme, THEME_STORAGE_KEY } from './theme';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('Button', () => {
  it('defaults to type="button", primary variant, and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(b.type).toBe('button');
    expect(b.className).toBe('btn btn-primary');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(<Button variant="link" disabled onClick={onClick}>Go</Button>);
    const b = screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.className).toBe('btn btn-link');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Badge and EmptyState', () => {
  it('carry their meaning as text', () => {
    render(
      <>
        <Badge tone="warning">Data gap</Badge>
        <EmptyState title="Nothing here.">
          <Button>Add one</Button>
        </EmptyState>
      </>,
    );
    expect(screen.getByText('Data gap').className).toBe('badge badge-warning');
    expect(screen.getByText('Nothing here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add one' })).toBeTruthy();
  });
});

describe('Spinner', () => {
  it('announces its label once through a single polite status region', () => {
    render(<Spinner label="Loading exposure…" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Loading exposure…');
    expect(status.hasAttribute('aria-label')).toBe(false);
    expect(status.querySelector('.spinner-mark')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ThemeToggle and theme policy', () => {
  it('defaults to following the system when nothing is stored', () => {
    expect(initTheme()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    render(<ThemeToggle />);
    expect((screen.getByLabelText('Theme') as HTMLSelectElement).value).toBe('system');
  });

  it('applies and persists the choice, and restores it after a reload', () => {
    render(<ThemeToggle />);
    const select = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dark' } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // Simulate a reload: fresh document state, then the startup init and a fresh toggle.
    cleanup();
    document.documentElement.removeAttribute('data-theme');
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    render(<ThemeToggle />);
    expect((screen.getByLabelText('Theme') as HTMLSelectElement).value).toBe('dark');

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'system' } });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('ignores an invalid stored value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(initTheme()).toBe('system');
  });

  it('keeps working when storage throws (choice lasts for the page only)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(initTheme()).toBe('system');
    render(<ThemeToggle />);
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect((screen.getByLabelText('Theme') as HTMLSelectElement).value).toBe('light');
  });

  it('offers system, light and dark as keyboard-operable native options', () => {
    render(<ThemeToggle />);
    const options = [...(screen.getByLabelText('Theme') as HTMLSelectElement).options].map((o) => [o.value, o.text]);
    expect(options).toEqual([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]);
  });
});

describe('Toast', () => {
  function Trigger({ message, tone }: { message: string; tone?: 'info' | 'success' | 'error' }) {
    const { notify } = useToast();
    return <button onClick={() => notify(message, tone)}>notify {message}</button>;
  }

  beforeEach(() => vi.useFakeTimers());

  it('shows a message in one polite region, without duplicates, and auto-dismisses it', () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'notify Saved' }));
    fireEvent.click(screen.getByRole('button', { name: 'notify Saved' }));
    expect(screen.getAllByText('Saved')).toHaveLength(1);
    expect(statuses[0].textContent).toContain('Saved');

    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(screen.queryByText('Saved')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('re-notifying a visible message restarts its timer instead of stacking', () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'notify Saved' }));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 100));
    fireEvent.click(screen.getByRole('button', { name: 'notify Saved' }));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getAllByText('Saved')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('routes errors to the alert region and can be dismissed by button', () => {
    render(
      <ToastProvider>
        <Trigger message="Import failed" tone="error" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'notify Import failed' }));
    expect(screen.getByRole('alert').textContent).toContain('Import failed');
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Import failed')).toBeNull();
  });

  it('throws a clear error when used outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Trigger message="x" />)).toThrow('useToast must be used inside <ToastProvider>');
  });
});
