/**
 * Typed egress (Phase 4a): the single path from a Contextualization to a
 * UserFacingContent — quote verification against real rows, guard-gated
 * construction, decision recording (append-only), and the nominal brand.
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
import type { ContextualizationDoc } from '@atlas/contracts';
import {
  UserFacingContent,
  isRejected,
  makePgGuardRecorder,
  makePgQuoteVerifier,
  renderUserFacingContent,
} from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let userId = '';
let thesisId = '';
let ruleId = '';

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
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink());
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'egress@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  userId = reg.json().id;
  const setCookie = reg.headers['set-cookie'];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = 'AAPL' AND valid_to IS NULL LIMIT 1`,
  );
  const thesis = await inject({
    method: 'POST',
    url: '/v1/theses',
    payload: {
      security_id: rows[0].security_id,
      statement: 'Services revenue makes Apple a compounder; the install base is the moat.',
    },
  });
  thesisId = thesis.json().data.id;
  const rule = await inject({
    method: 'POST',
    url: '/v1/rules',
    payload: {
      type: 'max_single_name',
      params: { limit: '0.2' },
      stated_reason: 'I got destroyed by a concentrated position once. Never again.',
    },
  });
  ruleId = rule.json().data.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function doc(): ContextualizationDoc {
  return {
    userId,
    subject: { scope: 'security' },
    sections: [
      {
        type: 'fact',
        spans: [
          { kind: 'text', text: 'Your look-through exposure to this name is ' },
          { kind: 'signal', signalId: 'lt_weight', format: 'percent', dp: 1 },
          { kind: 'text', text: ' of the portfolio.' },
        ],
      },
      {
        type: 'tension',
        tensionType: 'T1',
        anchor: { table: 'rules', id: '' }, // filled per test
        spans: [
          { kind: 'text', text: 'When you set your concentration rule you wrote: ' },
          {
            kind: 'user_quote',
            text: 'I got destroyed by a concentrated position once. Never again.',
            source: { table: 'rules', id: '', column: 'stated_reason' },
          },
        ],
      },
      {
        type: 'unknown',
        spans: [{ kind: 'text', text: 'Whether the segment weakness is cyclical is not knowable from this filing.' }],
      },
    ],
    confidence: {
      level: 'medium',
      basis: [{ kind: 'text', text: 'Full quarterly history on record for this name.' }],
      whatWouldChangeIt: ['Next quarter segment-level disclosure'],
    },
    signals: {
      lt_weight: {
        value: '0.224',
        provenance: {
          engineVersion: '1.0.0',
          inputHash: 'testhash',
          methodology: 'lookthrough.v1',
          inputs: { pricesAsOf: '2026-06-30', fxAsOf: '2026-06-30', holdingsAsOf: '2026-06-30' },
        },
      },
    },
    generator: { agent: 'psa', promptVersion: 'psa.v1', model: 'fixture' },
  };
}

const opts = () => ({
  verifyQuote: makePgQuoteVerifier(pool),
  recordDecision: makePgGuardRecorder(pool),
});

describe('the single egress path (§A4.1)', () => {
  it('renders a clean document: numbers formatted from the bundle, quote verified, guard approved', async () => {
    const d = doc();
    d.sections[1]!.anchor!.id = ruleId;
    (d.sections[1]!.spans[1] as { source: { id: string } }).source.id = ruleId;

    const result = await renderUserFacingContent(d, opts());
    expect(isRejected(result)).toBe(false);
    const ufc = result as UserFacingContent;
    expect(ufc).toBeInstanceOf(UserFacingContent);
    expect(ufc.text).toContain('22.4%'); // formatted from the signal, not generated
    expect(ufc.text).toContain('Never again.'); // the user's own words
    expect(ufc.text).toContain('What would change this:'); // §17.4 rendered
    expect(ufc.guard.approved).toBe(true);

    const { rows } = await pool.query(
      `SELECT verdict, ruleset_version FROM guard_decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0].verdict).toBe('approved');
    expect(rows[0].ruleset_version).toBe('lex.v1');
  });

  it('rejects a doctored quote — verbatim match against the stored row (§6.2)', async () => {
    const d = doc();
    d.sections[1]!.anchor!.id = ruleId;
    const quote = d.sections[1]!.spans[1] as { text: string; source: { id: string } };
    quote.source.id = ruleId;
    quote.text = 'I always said concentration is fine in moderation.'; // not what they wrote

    const result = await renderUserFacingContent(d, opts());
    expect(isRejected(result)).toBe(true);
    if (isRejected(result)) {
      expect(result.verdict.violations.some((v) => v.code === 'struct.quote_mismatch')).toBe(true);
    }
    const { rows } = await pool.query(
      `SELECT verdict FROM guard_decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0].verdict).toBe('rejected'); // rejections are audited too
  });

  it('verifies thesis quotes against theses.statement', async () => {
    const ok = await makePgQuoteVerifier(pool)(
      { table: 'theses', id: thesisId, column: 'statement' },
      'the install base is the moat',
    );
    expect(ok).toBe(true);
    const bad = await makePgQuoteVerifier(pool)(
      { table: 'theses', id: thesisId, column: 'statement' },
      'I never liked this company',
    );
    expect(bad).toBe(false);
  });

  it('refuses non-allow-listed quote sources', async () => {
    const ok = await makePgQuoteVerifier(pool)(
      { table: 'users' as never, id: userId, column: 'email' },
      'egress@example.es',
    );
    expect(ok).toBe(false);
  });

  it('a directive that survives rendering is stopped by the guard and recorded', async () => {
    const d = doc();
    d.sections[1]!.anchor!.id = ruleId;
    (d.sections[1]!.spans[1] as { source: { id: string } }).source.id = ruleId;
    d.sections.push({
      type: 'nuance',
      spans: [{ kind: 'text', text: 'Given all this, you should sell half the position.' }],
    });
    const result = await renderUserFacingContent(d, opts());
    expect(isRejected(result)).toBe(true);
    if (isRejected(result)) {
      expect(result.verdict.violations.some((v) => v.code === 'lex.directive_second_person')).toBe(true);
    }
  });

  it('guard_decisions is append-only at the database level', async () => {
    await expect(pool.query(`UPDATE guard_decisions SET verdict = 'approved'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`DELETE FROM guard_decisions`)).rejects.toThrow(/append-only/);
  });
});
