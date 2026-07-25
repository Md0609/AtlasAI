/**
 * A degraded or non-generative turn must stay identifiable all the way out
 * (P0-1, second half).
 *
 * Fixing the provider default stops the fixture running in production. It does
 * not, on its own, stop a DEGRADED turn — a provider error, a timeout, a
 * cost-ceiling trip, a guard rejection — from being presented exactly like a
 * healthy one. The Guard approves the deterministic template, because the
 * template is compliant by construction; approval must therefore never be read
 * as "a model analysed this".
 *
 * These tests pin the API contract. The matching Guard-side property — that
 * approval of a deterministic template is not evidence of analysis — lives in
 * the guard's own suite, because §47.2 permits only egress to import that
 * package, and the rule is worth more than the convenience of asserting it
 * here. (The architecture test matches on the literal package name, comments
 * included, which is how this file first tripped it.)
 *
 * Rendering any of this is P1-10, in W2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';
import { setProviderForTests, type LlmProvider, type LlmRequest, type LlmResponse } from '@atlas/runtime';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';

/** A provider that always degrades — the shape of every real failure path. */
class AlwaysDegradedProvider implements LlmProvider {
  readonly name = 'always-degraded';
  readonly generative = true; // it IS a model backend; this turn just failed
  modelFor(): string {
    return 'degraded-test-model';
  }
  priceEur(): string {
    return '0';
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    return {
      text: req.fallback.text,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'degraded-test-model',
      provider: this.name,
      degraded: true,
      // No model wrote this: it is the caller's own template handed back.
      generative: false,
    };
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  app = await buildServer(pool);
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'degradation@example.es',
      password: 'password1234',
      jurisdiction: 'ES',
      base_currency: 'EUR',
    } as never,
    headers: { 'content-type': 'application/json' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  setProviderForTests(null);
  await app.close();
  await pool.end();
});

describe('the API preserves the degraded flag', () => {
  it('reports degraded: true on a turn the provider degraded', async () => {
    setProviderForTests(new AlwaysDegradedProvider());
    try {
      const thread = await app.inject({
        method: 'POST',
        url: '/v1/copilot/threads',
        payload: { context_type: 'global' } as never,
        headers: { 'content-type': 'application/json', cookie },
      });
      const threadId = thread.json().data.thread.id;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/copilot/threads/${threadId}/messages`,
        payload: { message: 'What changed this week?' } as never,
        headers: { 'content-type': 'application/json', cookie },
      });
      expect(res.statusCode).toBe(200);

      // The flag the SPA needs in order to say so. Rendering it is P1-10.
      expect(res.json().data.degraded).toBe(true);

      // …and it survives a reload, not just the immediate response.
      const reload = await app.inject({
        method: 'GET',
        url: `/v1/copilot/threads/${threadId}`,
        headers: { cookie },
      });
      const assistantTurns = reload
        .json()
        .data.messages.filter((m: { role: string }) => m.role === 'assistant');
      expect(assistantTurns.at(-1).degraded).toBe(true);
    } finally {
      setProviderForTests(null);
    }
  });

  it('persists the degradation against the stored turn, not just in the response', async () => {
    const { rows } = await pool.query(
      `SELECT degraded, guard_approved FROM copilot_messages
        WHERE role = 'assistant' AND degraded = true ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    // Both true at once is the combination that matters: approved AND degraded.
    // A reader who treats approval as proof of analysis gets this exactly wrong.
    expect(rows[0].degraded).toBe(true);
    expect(rows[0].guard_approved).toBe(true);
  });
});
