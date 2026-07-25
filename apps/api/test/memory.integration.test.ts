/**
 * Memory end-to-end (F-30 / FR-10): material Copilot exchanges are persisted
 * (FR-10.1) and injected into later turns (FR-10.3); the user can see and delete
 * what Atlas knows (§30.6); memory is exportable (FR-10.5) and erased with the
 * account.
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
import { buildRunner } from '@atlas/workers';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let userId = '';
let aaplId = '';

const inject = (opts: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: unknown; cookie?: string }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      cookie: opts.cookie ?? cookie,
    },
  });

async function register(email: string): Promise<{ cookie: string; id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
    headers: { 'content-type': 'application/json' },
  });
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, id: res.json().id };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  process.env.ATLAS_ERASURE_GRACE_DAYS = '0';
  app = await buildServer(pool);
  const s = await register('memory@example.es');
  cookie = s.cookie;
  userId = s.id;
  aaplId = (await pool.query(`SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`)).rows[0].security_id;
});

afterAll(async () => {
  delete process.env.ATLAS_ERASURE_GRACE_DAYS;
  await app.close();
  await pool.end();
});

describe('Copilot exchanges become memory and are injected into later turns', () => {
  it('persists a turn (FR-10.1) and surfaces it in the §30.6 list', async () => {
    const thread = await inject({ method: 'POST', url: '/v1/copilot/threads', payload: { context_type: 'security', context_ref: aaplId } });
    const threadId = thread.json().data.thread.id as string;

    await inject({
      method: 'POST',
      url: `/v1/copilot/threads/${threadId}/messages`,
      payload: { message: 'Remind me about the services mix question' },
    });

    const mem = await inject({ method: 'GET', url: '/v1/memory' });
    expect(mem.statusCode).toBe(200);
    const items = mem.json().data;
    expect(items.length).toBeGreaterThan(0);
    // Visible with its provenance (§30.6): what, from where, when.
    expect(items[0].content).toContain('services mix');
    expect(items[0].source).toBe('copilot');
    expect(items[0].source_ref).toBe(threadId);
    expect(items[0].security_name).toMatch(/Apple/);
  });

  it('injects remembered context into a later turn (FR-10.3)', async () => {
    // A second thread — the memory from the first must still be reachable.
    const thread = await inject({ method: 'POST', url: '/v1/copilot/threads', payload: { context_type: 'security', context_ref: aaplId } });
    const threadId = thread.json().data.thread.id as string;
    const turn = await inject({
      method: 'POST',
      url: `/v1/copilot/threads/${threadId}/messages`,
      payload: { message: 'services mix' },
    });
    expect(turn.statusCode).toBe(200);
    // The turn was answered and guarded with memory in context; the exchange
    // itself is now remembered too, so the store grows.
    const mem = await inject({ method: 'GET', url: '/v1/memory' });
    expect(mem.json().data.length).toBeGreaterThan(1);
  });

  it('lets the user delete an item (§30.6), and 404s on someone else\'s', async () => {
    const before = (await inject({ method: 'GET', url: '/v1/memory' })).json().data;
    const del = await inject({ method: 'DELETE', url: `/v1/memory/${before[0].id}` });
    expect(del.statusCode).toBe(204);
    const after = (await inject({ method: 'GET', url: '/v1/memory' })).json().data;
    expect(after.length).toBe(before.length - 1);
    // The embedding went with it.
    const emb = await pool.query(`SELECT count(*)::int n FROM memory_embeddings WHERE memory_item_id = $1`, [before[0].id]);
    expect(emb.rows[0].n).toBe(0);

    const other = await register('other-mem@example.es');
    const foreign = await inject({ method: 'DELETE', url: `/v1/memory/${before[1].id}`, cookie: other.cookie });
    expect(foreign.statusCode).toBe(404); // tenant-isolated (FR-10.6)
  });
});

describe('memory is exportable and erasable (FR-10.5)', () => {
  it('appears in the export bundle and is deleted with the account', async () => {
    const exp = await inject({ method: 'GET', url: '/v1/account/export' });
    expect(exp.json().data.memory_items.length).toBeGreaterThan(0);

    // Erasure now re-authenticates (P1-2).
    const del = await inject({ method: 'DELETE', url: '/v1/account', payload: { password: 'password1234' } });
    expect(del.statusCode).toBe(202);
    const { stats } = await buildRunner(pool).drain();
    expect(stats.dead).toBe(0);

    const left = await pool.query(`SELECT count(*)::int n FROM memory_items WHERE user_id = $1`, [userId]);
    expect(left.rows[0].n).toBe(0);
    const orphanEmb = await pool.query(
      `SELECT count(*)::int n FROM memory_embeddings me
        LEFT JOIN memory_items mi ON mi.id = me.memory_item_id WHERE mi.id IS NULL`,
    );
    expect(orphanEmb.rows[0].n).toBe(0); // cascaded, no orphans
  });
});
