import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Test helper for the web render tests: replaces global `fetch` with a router of canned API
 * responses so the real `api.ts` client runs against mocked JSON. Each call is recorded.
 */
export interface MockCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: MockCall) => { status?: number; body?: unknown };

export function mockApi(routes: Record<string, Handler | object>) {
  const calls: MockCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const call: MockCall = {
        method,
        path: input,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const key = `${method} ${input.split('?')[0]}`;
      const route = routes[key];
      if (route === undefined) {
        return new Response(JSON.stringify({ type: 'about:blank', title: `Unmocked ${key}`, status: 404, trace_id: 't' }), {
          status: 404,
        });
      }
      const { status = 200, body } = typeof route === 'function' ? (route as Handler)(call) : { body: route };
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
