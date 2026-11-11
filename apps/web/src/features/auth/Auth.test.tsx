// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../test/mockApi';
import { Auth } from './Auth';

const me = { id: 'u1', email: 'ana@example.com', jurisdiction: 'ES', base_currency: 'EUR' };

describe('Auth', () => {
  it('renders the login form and logs in against the API', async () => {
    const calls = mockApi({ 'POST /v1/auth/login': () => ({ status: 204 }), 'GET /v1/me': me });
    const onAuthed = vi.fn();
    render(<Auth onAuthed={onAuthed} />);

    expect(screen.getByRole('heading', { name: 'Atlas' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Jurisdiction/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith(me));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email: 'ana@example.com', password: 'secret-pass' },
    });
  });

  it('switches to the register form with jurisdiction and base currency', async () => {
    const calls = mockApi({ 'POST /v1/auth/register': () => ({ status: 201, body: {} }), 'GET /v1/me': me });
    render(<Auth onAuthed={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Need an account? Register' }));
    const jurisdiction = screen.getByLabelText(/^Jurisdiction/) as HTMLSelectElement;
    const currency = screen.getByLabelText(/^Base currency/) as HTMLSelectElement;
    expect(jurisdiction.value).toBe('ES');
    expect(currency.value).toBe('EUR');
    fireEvent.change(currency, { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].body).toMatchObject({ jurisdiction: 'ES', base_currency: 'USD' });
  });

  it('shows the problem+json title and detail on failure', async () => {
    mockApi({
      'POST /v1/auth/login': () => ({
        status: 401,
        body: { type: 'x', title: 'Invalid credentials', status: 401, detail: 'Check your email', trace_id: 't' },
      }),
    });
    const { container } = render(<Auth onAuthed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(container.querySelector('.error')?.textContent).toBe('Invalid credentials — Check your email'));
  });
});
