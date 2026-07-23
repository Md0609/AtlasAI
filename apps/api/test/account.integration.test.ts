/**
 * Account portability + erasure (Phase 5, F-31 / US-ACC-01/02 / FR-1.5/1.6).
 *
 * Export returns everything as JSON and as a readable document. Erasure
 * hard-deletes user content (including the immutable content tables via the
 * controlled GDPR exception), pseudonymizes the retained audit log, deletes the
 * user, and leaves the disclosed deletion record — while a SECOND user's data
 * and the normal immutability walls are untouched.
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

interface Session {
  cookie: string;
  userId: string;
}

async function inject(session: Session | null, opts: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: unknown }) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
  });
}

async function register(email: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
    headers: { 'content-type': 'application/json' },
  });
  const setCookie = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!, userId: res.json().id };
}

async function seed(s: Session): Promise<{ aaplId: string }> {
  const { rows } = await pool.query(`SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`);
  const aaplId = rows[0].security_id as string;
  await inject(s, { method: 'POST', url: '/v1/profile', payload: { experience_level: 'intermediate', horizon_years: 10, stated_strategy: 'value' } });
  const p = await inject(s, { method: 'POST', url: '/v1/portfolios', payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' } });
  const pid = p.json().id;
  await inject(s, { method: 'POST', url: `/v1/portfolios/${pid}/transactions`, payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' } });
  await inject(s, { method: 'POST', url: `/v1/portfolios/${pid}/transactions`, payload: { type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '100', price: '210', currency: 'USD' } });
  // Immutable content: a thesis, a rule (audit_log), a decision, a copilot turn
  // (copilot_messages + guard_decisions + agent_messages).
  const th = await inject(s, { method: 'POST', url: '/v1/theses', payload: { security_id: aaplId, statement: 'Services revenue makes this a compounder.' } });
  await inject(s, { method: 'POST', url: '/v1/rules', payload: { type: 'max_single_name', params: { limit: '0.15' }, stated_reason: 'One name should not sink me.' } });
  await inject(s, { method: 'POST', url: '/v1/decisions', payload: { action: 'no_change', security_id: aaplId, thesis_id: th.json().data.id, reason: 'Thesis intact; nothing to do.' } });
  await inject(s, { method: 'POST', url: '/v1/copilot/threads', payload: { context_type: 'security', context_ref: aaplId } });
  return { aaplId };
}

async function counts(userId: string): Promise<Record<string, number>> {
  const tables = ['portfolios', 'transactions', 'theses', 'thesis_conditions', 'rules', 'decisions', 'profile_versions', 'copilot_messages', 'copilot_threads'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const col = t === 'thesis_conditions' ? `thesis_id IN (SELECT id FROM theses WHERE user_id=$1)` : t === 'transactions' ? `portfolio_id IN (SELECT id FROM portfolios WHERE user_id=$1)` : `user_id=$1`;
    out[t] = Number((await pool.query(`SELECT count(*)::int n FROM ${t} WHERE ${col}`, [userId])).rows[0].n);
  }
  return out;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  process.env.ATLAS_ERASURE_GRACE_DAYS = '0'; // erase immediately in the test
  app = await buildServer(pool);
});

afterAll(async () => {
  delete process.env.ATLAS_ERASURE_GRACE_DAYS;
  await app.close();
  await pool.end();
});

describe('GET /v1/account/export', () => {
  it('returns everything as JSON and as a readable HTML document', async () => {
    const s = await register('export@example.es');
    await seed(s);

    const json = await inject(s, { method: 'GET', url: '/v1/account/export' });
    expect(json.statusCode).toBe(200);
    const d = json.json().data;
    expect(d.account.email).toBe('export@example.es');
    expect(d.portfolios.length).toBe(1);
    expect(d.theses.length).toBe(1);
    expect(d.decisions.length).toBe(1);
    expect(d.rules.length).toBe(1);
    expect(json.headers['content-disposition']).toContain('atlas-export.json');

    const html = await inject(s, { method: 'GET', url: '/v1/account/export?format=html' });
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.payload).toContain('Services revenue makes this a compounder'); // their own words
    expect(html.payload).toContain('Your Atlas record');
  });
});

describe('DELETE /v1/account — GDPR erasure', () => {
  it('issues a certificate, hard-deletes content, pseudonymizes the audit log, and keeps the disclosed record', async () => {
    const victim = await register('erase-me@example.es');
    await seed(victim);
    const bystander = await register('keep-me@example.es');
    await seed(bystander);

    const before = await counts(victim.userId);
    expect(before.theses).toBe(1);
    expect(before.copilot_messages).toBeGreaterThan(0);

    const del = await inject(victim, { method: 'DELETE', url: '/v1/account' });
    expect(del.statusCode).toBe(202);
    const cert = del.json().data.certificate as string;
    expect(cert).toMatch(/^atlas-erasure-/);

    // Requested + account marked cancelled + a job scheduled.
    const rec0 = await pool.query(`SELECT status FROM account_deletions WHERE certificate=$1`, [cert]);
    expect(rec0.rows[0].status).toBe('requested');
    // Export stays available during grace, so the account is still authed.
    const stillWorks = await inject(victim, { method: 'GET', url: '/v1/account/export' });
    expect(stillWorks.statusCode).toBe(200);

    // Run the erasure (grace = 0 ⇒ due now).
    const { stats } = await buildRunner(pool).drain();
    expect(stats.dead).toBe(0);

    // All user content gone.
    const after = await counts(victim.userId);
    for (const [t, n] of Object.entries(after)) expect(n, `${t} not erased`).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM users WHERE id=$1`, [victim.userId])).rows[0].n).toBe(0);

    // Audit log RETAINED but pseudonymized (PII severed).
    const gd = await pool.query(`SELECT count(*)::int n FROM guard_decisions WHERE user_id=$1`, [victim.userId]);
    expect(gd.rows[0].n).toBe(0); // no rows still linked to the user
    const am = await pool.query(`SELECT count(*)::int total, count(*) FILTER (WHERE user_id=$1) linked FROM agent_messages`, [victim.userId]);
    expect(Number(am.rows[0].linked)).toBe(0);

    // The disclosed deletion record survives, marked complete with what it touched.
    const rec = await pool.query(`SELECT status, tables_erased, completed_at FROM account_deletions WHERE certificate=$1`, [cert]);
    expect(rec.rows[0].status).toBe('completed');
    expect(rec.rows[0].completed_at).not.toBeNull();
    expect(rec.rows[0].tables_erased.users).toBe(1);

    // The bystander is completely untouched.
    const other = await counts(bystander.userId);
    expect(other.theses).toBe(1);
    expect(other.decisions).toBe(1);
  });

  it('is idempotent: a second request returns the same certificate', async () => {
    const s = await register('twice@example.es');
    const a = await inject(s, { method: 'DELETE', url: '/v1/account' });
    const b = await inject(s, { method: 'DELETE', url: '/v1/account' });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202); // still authed during the grace window
    expect(a.json().data.certificate).toBe(b.json().data.certificate);
  });

  it('normal immutability still holds — the exception is scoped to the erasure transaction', async () => {
    const s = await register('immutable@example.es');
    const { aaplId } = await seed(s);
    const { rows } = await pool.query(`SELECT id FROM decisions WHERE user_id=$1 LIMIT 1`, [s.userId]);
    // A plain DELETE (no erasure GUC) is still refused.
    await expect(pool.query(`DELETE FROM decisions WHERE id=$1`, [rows[0].id])).rejects.toThrow(/append-only/);
    expect(aaplId).toBeTruthy();
  });
});
