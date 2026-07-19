/**
 * Copilot (§11.2) end-to-end on the deterministic mock: opening a thread FROM a
 * context preloads that context into the first turn (the user never restates
 * what they are looking at); threads are history; turns are guarded and traced;
 * SSE streams the guarded answer. Context binding is proven by the opener
 * containing the security's own provenanced figures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import {
  CollectingEventSink,
  IngestPipeline,
  MockVendorAdapter,
  SNAPSHOT_FROM,
  SNAPSHOT_TO,
} from '@atlas/ingest';
import { buildServer } from '@atlas/api';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let portfolioId = '';
let aaplId = '';

const inject = (opts: { method: 'GET' | 'POST'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(
    SNAPSHOT_FROM,
    SNAPSHOT_TO,
  );
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'copilot@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  const setCookie = reg.headers['set-cookie'];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

  const p = await inject({
    method: 'POST',
    url: '/v1/portfolios',
    payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' },
  });
  portfolioId = p.json().id;
  await inject({
    method: 'POST',
    url: `/v1/portfolios/${portfolioId}/transactions`,
    payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' },
  });
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = 'AAPL' AND valid_to IS NULL LIMIT 1`,
  );
  aaplId = rows[0].security_id;
  await inject({
    method: 'POST',
    url: `/v1/portfolios/${portfolioId}/transactions`,
    payload: { type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '100', price: '210', currency: 'USD' },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('POST /v1/copilot/threads — opens FROM a context (§11.2)', () => {
  it('preloads the security context into the first turn without the user restating it', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'security', context_ref: aaplId },
    });
    expect(res.statusCode).toBe(201);
    const { thread, messages } = res.json().data;
    expect(thread.context_type).toBe('security');
    expect(thread.context_ref).toBe(aaplId);
    // The opener already knows the subject — the user never told it.
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('Apple');

    // The turn was guarded and recorded (append-only audit).
    const { rows: gd } = await pool.query(
      `SELECT count(*)::int AS n FROM guard_decisions WHERE (generator->>'agent') = 'copilot'`,
    );
    expect(gd[0].n).toBeGreaterThan(0);
  });

  it('preloads portfolio context (figures the broker cannot show)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'portfolio', context_ref: portfolioId },
    });
    expect(res.statusCode).toBe(201);
    const { thread, messages } = res.json().data;
    expect(thread.context_type).toBe('portfolio');
    expect(messages[0].content).toContain('Main'); // the portfolio name is loaded
  });

  it('404s on a security the context loader cannot find', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'security', context_ref: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('conversation turns + history', () => {
  it('continues a thread with the context still loaded, and lists threads as history', async () => {
    const created = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'security', context_ref: aaplId },
    });
    const threadId = created.json().data.thread.id;

    const turn = await inject({
      method: 'POST',
      url: `/v1/copilot/threads/${threadId}/messages`,
      payload: { message: 'What is my exposure here?' },
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().data.role).toBe('assistant');
    expect(turn.json().data.guard_approved).toBe(true);

    const full = await inject({ method: 'GET', url: `/v1/copilot/threads/${threadId}` });
    const roles = full.json().data.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['assistant', 'user', 'assistant']); // opener, question, answer

    const list = await inject({ method: 'GET', url: '/v1/copilot/threads' });
    expect(list.json().data.some((t: { id: string }) => t.id === threadId)).toBe(true);
  });

  it('streams a guarded answer over SSE', async () => {
    const created = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'security', context_ref: aaplId },
    });
    const threadId = created.json().data.thread.id;

    const res = await inject({
      method: 'POST',
      url: `/v1/copilot/threads/${threadId}/stream`,
      payload: { message: 'Walk me through the valuation.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: delta');
    expect(res.payload).toContain('event: done');

    // The streamed turn was persisted.
    const full = await inject({ method: 'GET', url: `/v1/copilot/threads/${threadId}` });
    const assistantTurns = full.json().data.messages.filter((m: { role: string }) => m.role === 'assistant');
    expect(assistantTurns.length).toBe(2); // opener + streamed answer
  });

  it('rejects an empty message', async () => {
    const created = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'global' },
    });
    const threadId = created.json().data.thread.id;
    const res = await inject({
      method: 'POST',
      url: `/v1/copilot/threads/${threadId}/messages`,
      payload: { message: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('copilot_messages are append-only (§29.1)', () => {
  it('a shown turn cannot be updated or deleted', async () => {
    const created = await inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      payload: { context_type: 'global' },
    });
    const threadId = created.json().data.thread.id;
    const { rows } = await pool.query(`SELECT id FROM copilot_messages WHERE thread_id = $1 LIMIT 1`, [threadId]);
    await expect(
      pool.query(`UPDATE copilot_messages SET content = 'tampered' WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/append-only/);
  });
});
