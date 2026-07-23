/**
 * Decision Journal (§11.1 / F-27). A unified, immutable, reverse-chronological
 * reasoning history over decisions, thesis lifecycle and rule lifecycle —
 * memory-ready entries. Copilot-derived entries are clearly attributed and link
 * back to their thread (FR-11.6); the append-only guarantee still holds.
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
let userId = '';
let aaplId = '';

const inject = (opts: { method: 'GET' | 'POST'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: { ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'journal@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;
  userId = reg.json().id;
  aaplId = (await pool.query(`SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`)).rows[0].security_id;

  // A thesis, a rule, and a plain user decision.
  await inject({ method: 'POST', url: '/v1/theses', payload: { security_id: aaplId, statement: 'Services makes this a compounder.' } });
  await inject({ method: 'POST', url: '/v1/rules', payload: { type: 'max_single_name', params: { limit: '0.2' }, stated_reason: 'No single name over 20%.' } });
  await inject({ method: 'POST', url: '/v1/decisions', payload: { action: 'no_change', security_id: aaplId, reason: 'Thesis intact; holding.' } });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/journal', () => {
  it('is a unified reverse-chronological timeline over decisions, theses and rules', async () => {
    const res = await inject({ method: 'GET', url: '/v1/journal' });
    expect(res.statusCode).toBe(200);
    const kinds = res.json().data.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('decision');
    expect(kinds).toContain('thesis_written');
    expect(kinds).toContain('rule_set');

    // Reverse chronological.
    const times = res.json().data.map((e: { occurred_at: string }) => e.occurred_at);
    expect([...times].sort().reverse()).toEqual(times);

    // A user decision is attributed to the user.
    const decision = res.json().data.find((e: { kind: string }) => e.kind === 'decision');
    expect(decision.source).toBe('user');
    expect(decision.detail).toContain('Thesis intact');
  });

  it('filters by security', async () => {
    const res = await inject({ method: 'GET', url: `/v1/journal?security_id=${aaplId}` });
    // Rules are portfolio-level (no security) ⇒ filtered out; theses/decisions on AAPL remain.
    expect(res.json().data.every((e: { kind: string; security_id: string | null }) => e.security_id === aaplId || e.kind.startsWith('thesis') || e.kind === 'decision')).toBe(true);
    expect(res.json().data.some((e: { kind: string }) => e.kind === 'rule_set')).toBe(false);
  });
});

describe('Copilot-derived journal entries (FR-11.6)', () => {
  it('are clearly attributed and link back to the thread', async () => {
    const thread = await inject({ method: 'POST', url: '/v1/copilot/threads', payload: { context_type: 'security', context_ref: aaplId } });
    const threadId = thread.json().data.thread.id as string;

    const dec = await inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { action: 'other', security_id: aaplId, reason: 'From my Copilot chat: the services mix is the crux.', source: 'copilot', source_thread_id: threadId },
    });
    expect(dec.statusCode).toBe(201);
    expect(dec.json().data.source).toBe('copilot');

    const journal = await inject({ method: 'GET', url: '/v1/journal' });
    const entry = journal.json().data.find((e: { source: string }) => e.source === 'copilot');
    expect(entry).toBeTruthy();
    expect(entry.source_ref).toBe(threadId); // attribution back to the exchange
    expect(entry.detail).toContain('services mix');
  });

  it('rejects a copilot decision with no thread, and one referencing a foreign thread', async () => {
    const noThread = await inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { action: 'other', reason: 'x', source: 'copilot' },
    });
    expect(noThread.statusCode).toBe(400);

    const foreign = await inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { action: 'other', reason: 'x', source: 'copilot', source_thread_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('journal history is immutable (§28)', () => {
  it('a recorded decision cannot be altered', async () => {
    const { rows } = await pool.query(`SELECT id FROM decisions WHERE user_id = $1 LIMIT 1`, [userId]);
    await expect(pool.query(`UPDATE decisions SET reason_free_text = 'rewritten' WHERE id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
  });
});
