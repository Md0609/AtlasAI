/**
 * The §21.6 regeneration loop through the REAL PSA path (generate → egress Guard
 * → regenerate → degrade) on providers that fail the Guard on purpose (the
 * fixture never would). Proves: a rejected turn is regenerated; a clean
 * regeneration is surfaced; exhausting the budget degrades to the safe doc; and
 * every attempt's verdict is recorded with its regeneration index.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import type { Finding, SecurityContext } from '@atlas/contracts';
import type { LlmProvider, LlmResponse } from '@atlas/runtime';
import { isRejected } from '@atlas/egress';
import { runPsa } from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let userId: string;
const securityId = '11111111-1111-1111-1111-111111111111';

const SECURITY: SecurityContext = {
  securityId,
  name: 'Apple',
  gicsSector: 'Information Technology',
  signals: {},
};
const FINDINGS: Finding[] = [
  {
    agent: 'financial_analysis',
    kind: 'financial.trend',
    statement: 'Revenue is the reference figure for the health of this business.',
    signalRefs: [],
    confidence: 'medium',
  },
];

/** A doc whose rendered prose trips the lexical guard (a directive). */
const directiveDoc = (uid: string): string =>
  JSON.stringify({
    userId: uid,
    subject: { scope: 'security', securityId },
    sections: [{ type: 'fact', spans: [{ kind: 'text', text: 'You should buy this now.' }] }],
    confidence: { level: 'medium', basis: [{ kind: 'text', text: 'the figures on record' }], whatWouldChangeIt: ['a filing'] },
    signals: {},
    generator: { agent: 'psa', promptVersion: '1.0.0', model: 'stub' },
  });

/** A clean, guard-passing doc. */
const cleanDoc = (uid: string): string =>
  JSON.stringify({
    userId: uid,
    subject: { scope: 'security', securityId },
    sections: [
      { type: 'fact', spans: [{ kind: 'text', text: 'This company reports its figures each quarter.' }] },
      { type: 'unknown', spans: [{ kind: 'text', text: 'Whether the load-bearing assumption holds is not knowable from the record.' }] },
    ],
    confidence: { level: 'medium', basis: [{ kind: 'text', text: 'the figures on record' }], whatWouldChangeIt: ['a filing'] },
    signals: {},
    generator: { agent: 'psa', promptVersion: '1.0.0', model: 'stub' },
  });

/** Returns the scripted texts in order, repeating the last one forever. */
function scriptedProvider(texts: string[]): LlmProvider {
  let i = 0;
  return {
    name: 'stub',
    modelFor: () => 'stub-mid',
    priceEur: () => '0.001',
    complete: async (): Promise<LlmResponse> => {
      const text = texts[Math.min(i, texts.length - 1)]!;
      i++;
      return {
        text,
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 20, outputTokens: 20 },
        model: 'stub-mid',
        provider: 'stub',
        degraded: false,
      };
    },
  };
}

const runsForThisUser = async (): Promise<Array<{ verdict: string; regenerated: number }>> => {
  const { rows } = await pool.query(
    `SELECT verdict, regenerated FROM guard_decisions
      WHERE user_id = $1 AND (generator->>'agent') LIKE 'psa%' ORDER BY id`,
    [userId],
  );
  return rows;
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
     VALUES ('regen@example.es','x','ES','EUR') RETURNING id`,
  );
  userId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('PSA regeneration loop (§21.6)', () => {
  it('surfaces a clean regeneration after an initial guard rejection', async () => {
    const before = (await runsForThisUser()).length;
    const res = await runPsa(pool, userId, 'EUR', SECURITY, FINDINGS, {
      traceId: 'trace-regen-1',
      provider: scriptedProvider([directiveDoc(userId), cleanDoc(userId)]),
    });
    expect(res.regenerations).toBe(1); // one rejection, then a clean retry
    expect(res.degraded).toBe(false);
    expect(isRejected(res.egress)).toBe(false);

    const runs = (await runsForThisUser()).slice(before);
    // A rejected verdict at regeneration 0, then an approved one at regeneration 1.
    expect(runs).toEqual([
      { verdict: 'rejected', regenerated: 0 },
      { verdict: 'approved', regenerated: 1 },
    ]);
  });

  it('degrades to the safe doc after exhausting the retry budget', async () => {
    const before = (await runsForThisUser()).length;
    const res = await runPsa(pool, userId, 'EUR', SECURITY, FINDINGS, {
      traceId: 'trace-regen-2',
      provider: scriptedProvider([directiveDoc(userId)]), // always rejectable
    });
    expect(res.regenerations).toBe(2); // §21.6: regenerate ≤2, then degrade
    expect(res.degraded).toBe(true);
    expect(isRejected(res.egress)).toBe(false); // the safe doc passes
    expect(res.doc.generator.agent).toBe('psa.safe');

    const runs = (await runsForThisUser()).slice(before);
    // Three rejections (regenerated 0,1,2), then the safe doc approved.
    expect(runs.filter((r) => r.verdict === 'rejected').map((r) => r.regenerated)).toEqual([0, 1, 2]);
    expect(runs.some((r) => r.verdict === 'approved')).toBe(true);
  });

  it('does not regenerate when the first attempt is already clean', async () => {
    const res = await runPsa(pool, userId, 'EUR', SECURITY, FINDINGS, {
      traceId: 'trace-regen-3',
      provider: scriptedProvider([cleanDoc(userId)]),
    });
    expect(res.regenerations).toBe(0);
    expect(res.degraded).toBe(false);
    expect(isRejected(res.egress)).toBe(false);
  });
});
