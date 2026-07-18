/**
 * Runtime primitives (Phase 4a): prompt registry rules, agent-message
 * tracing (append-only), cost accumulation and the §37.3 ceilings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import {
  COST_CEILINGS,
  PSA_BRIEF_NARRATOR,
  addCost,
  checkCostCeiling,
  composePrompt,
  getPrompt,
  newTraceId,
  recordAgentMessage,
  registerPrompt,
} from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let userId = '';

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
     VALUES ('runtime@example.es', 'x', 'ES', 'EUR') RETURNING id`,
  );
  userId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('prompt registry (§38)', () => {
  it('the seed prompt is registered, composed in §38.2 volatility order, and hashed', () => {
    const p = getPrompt('psa.brief_narrator');
    expect(p.version).toBe('1.0.0');
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    const composed = composePrompt(p.sections);
    expect(composed.indexOf('[SYSTEM]')).toBeLessThan(composed.indexOf('[CONTRACT]'));
    expect(composed.indexOf('[CONTRACT]')).toBeLessThan(composed.indexOf('[USER CONTEXT]'));
    expect(composed.indexOf('[USER CONTEXT]')).toBeLessThan(composed.indexOf('[TASK]'));
    // The doctrine is explained WITH its reason (§38.4).
    expect(composed.replace(/\s+/g, ' ')).toContain('make them think, not to think for them');
    expect(PSA_BRIEF_NARRATOR.hash).toBe(p.hash);
  });

  it('rejects a prompt that instructs the model to compute (P4 lint)', () => {
    expect(() =>
      registerPrompt({
        agent: 'bad.calculator',
        version: '1.0.0',
        sections: {
          system: 'You are an analyst.',
          contract: 'Return JSON.',
          context: 'Data provided.',
          task: 'Calculate the portfolio weight and report it.',
        },
      }),
    ).toThrow(/never instruct the model to compute/);
  });

  it('rejects "be helpful" and non-semver versions (§38.4/§38.3)', () => {
    expect(() =>
      registerPrompt({
        agent: 'bad.helpful',
        version: '1.0.0',
        sections: { system: 'Be helpful.', contract: 'x', context: 'x', task: 'x' },
      }),
    ).toThrow(/helpful/);
    expect(() =>
      registerPrompt({
        agent: 'bad.version',
        version: 'v1',
        sections: { system: 'x', contract: 'x', context: 'x', task: 'x' },
      }),
    ).toThrow(/semver/);
  });

  it('one active version per agent — duplicate registration fails loudly', () => {
    expect(() =>
      registerPrompt({
        agent: 'psa.brief_narrator',
        version: '1.0.1',
        sections: { system: 'x', contract: 'x', context: 'x', task: 'x' },
      }),
    ).toThrow(/already registered/);
  });
});

describe('agent-message tracing (§23.4)', () => {
  it('records a span and the log is append-only', async () => {
    const traceId = newTraceId();
    const spanId = await recordAgentMessage(pool, {
      traceId,
      userId,
      agent: 'psa.brief_narrator',
      promptVersion: '1.0.0',
      promptHash: PSA_BRIEF_NARRATOR.hash,
      model: 'fixture',
      inputHash: 'abc123',
      output: { sections: 2 },
      costEur: '0.04',
      latencyMs: 812,
    });
    expect(spanId).toBeTruthy();
    const { rows } = await pool.query(
      `SELECT agent, prompt_version, cost_eur::text FROM agent_messages WHERE trace_id = $1`,
      [traceId],
    );
    expect(rows[0].agent).toBe('psa.brief_narrator');
    expect(rows[0].cost_eur).toBe('0.04');
    await expect(pool.query(`UPDATE agent_messages SET cost_eur = 0`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM agent_messages`)).rejects.toThrow(/append-only/);
  });
});

describe('cost ceilings are enforced, not aspirational (§37.3)', () => {
  it('accumulates per (user, day, surface) in SQL numeric arithmetic', async () => {
    await addCost(pool, userId, 'brief_narration', '0.04');
    await addCost(pool, userId, 'brief_narration', '0.03');
    const { rows } = await pool.query(
      `SELECT eur::text FROM cost_ledger WHERE user_id = $1 AND surface = 'brief_narration'`,
      [userId],
    );
    expect(rows[0].eur).toBe('0.07');
  });

  it('a single request over €1 is refused outright', async () => {
    const check = await checkCostCeiling(pool, userId, '1.50');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('hard abort');
  });

  it('the €2/day ceiling degrades further spend', async () => {
    await addCost(pool, userId, 'copilot', '1.90');
    const check = await checkCostCeiling(pool, userId, '0.20');
    expect(check.allowed).toBe(false);
    expect(check.degrade).toBe(true);
    expect(check.reason).toContain('daily ceiling');
    const small = await checkCostCeiling(pool, userId, '0.02');
    expect(small.allowed).toBe(true);
  });

  it(`ceilings match §37.3 verbatim`, () => {
    expect(COST_CEILINGS).toEqual({
      perRequestEur: '1.00',
      perUserDayEur: '2.00',
      perUserMonthEur: '18.00',
    });
  });
});
