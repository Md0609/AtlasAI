/**
 * Narration (§B1 / §B10) on custom providers that the deterministic mock can't
 * emulate: the happy rephrase path, and the three degradation paths that keep
 * narration honest without the structural guard — provider degradation, numeral
 * drift, and a directive leaking past into prose (guard rejection). Every path
 * must land on the provenanced template, and every guard decision is recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import type { LlmProvider, LlmResponse } from '@atlas/runtime';
import { narrate } from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

const TEMPLATE =
  'Your direct Apple position is 12.0% of the portfolio. But your funds hold it too: ' +
  'the real exposure is 18.5% — 6.5% arrives through funds and is invisible in your broker.';

let pool: pg.Pool;
let userId: string;

/** A provider that returns a fixed body regardless of the request. */
function fixedProvider(text: string, degraded = false): LlmProvider {
  return {
    name: 'stub',
    generative: false,
    modelFor: () => 'stub-small',
    priceEur: () => '0.0001',
    complete: async (req): Promise<LlmResponse> => ({
      text: degraded ? req.fallback.text : text,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'stub-small',
      provider: 'stub',
      degraded,
      generative: false,
    }),
  };
}

async function narratorDecisions(): Promise<{ approved: number; rejected: number }> {
  const { rows } = await pool.query(
    `SELECT verdict, count(*)::int AS n FROM guard_decisions
      WHERE (generator->>'agent') = 'narrator' GROUP BY verdict`,
  );
  const out = { approved: 0, rejected: 0 };
  for (const r of rows) out[r.verdict as 'approved' | 'rejected'] = r.n;
  return out;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
     VALUES ('narr@example.es','x','ES','EUR') RETURNING id`,
  );
  userId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('narrate (§B1)', () => {
  it('accepts a rephrase that preserves every figure and stays guard-clean', async () => {
    // Reworded prose, identical numbers, no directive.
    const reworded =
      'Directly you hold 12.0% of the portfolio in Apple, yet the true figure is 18.5%: a further ' +
      '6.5% reaches you through funds, where your broker never shows it.';
    const res = await narrate(pool, {
      userId,
      surface: 'reality_check',
      template: TEMPLATE,
      provider: fixedProvider(reworded),
    });
    expect(res.degraded).toBe(false);
    expect(res.text).toBe(reworded);
    expect(res.guard.approved).toBe(true);
    expect((await narratorDecisions()).approved).toBeGreaterThan(0);
  });

  it('degrades to the template when the provider degrades', async () => {
    const res = await narrate(pool, {
      userId,
      surface: 'reality_check',
      template: TEMPLATE,
      provider: fixedProvider('unused', true),
    });
    expect(res.degraded).toBe(true);
    expect(res.text).toBe(TEMPLATE);
  });

  it('degrades to the template on numeral drift (an invented figure)', async () => {
    // Same shape, but "18.5%" became "19.9%" — a figure not in the source.
    const drifted =
      'Directly you hold 12.0% of the portfolio in Apple, yet the true figure is 19.9%: a further ' +
      '6.5% reaches you through funds.';
    const res = await narrate(pool, {
      userId,
      surface: 'reality_check',
      template: TEMPLATE,
      provider: fixedProvider(drifted),
    });
    expect(res.degraded).toBe(true);
    expect(res.text).toBe(TEMPLATE); // never surfaces the invented number
  });

  it('degrades to the template and records a rejection when a directive leaks in', async () => {
    const before = await narratorDecisions();
    const directive =
      'Your real Apple exposure is 18.5%. You should sell some to get back under 12.0%.';
    const res = await narrate(pool, {
      userId,
      surface: 'reality_check',
      template: TEMPLATE,
      provider: fixedProvider(directive),
    });
    expect(res.degraded).toBe(true);
    expect(res.text).toBe(TEMPLATE);
    expect(res.guard.approved).toBe(false);
    const after = await narratorDecisions();
    expect(after.rejected).toBe(before.rejected + 1); // audit trail on the reject path
  });
});
