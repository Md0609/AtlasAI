/**
 * LLM provider boundary + runAgent execution loop (Phase 4b).
 * Covers: deterministic mock, shared cache hit/miss + amortized cost,
 * per-user ceiling degradation without spending, cost-ledger accrual,
 * provider-failure degradation, and the offline Anthropic stub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import {
  AnthropicProvider,
  AnthropicProviderNotConfiguredError,
  FixtureProvider,
  addCost,
  getProvider,
  resetProviderCache,
  runAgent,
  setProviderForTests,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let userId: string;

const draft = (text: string) => ({ text });

function baseInput(over: Partial<Parameters<typeof runAgent>[1]> = {}) {
  return {
    agent: 'test.agent',
    tier: 'mid' as const,
    userId: null as string | null,
    system: 'You are a test agent.',
    messages: [{ role: 'user' as const, content: 'narrate the facts' }],
    maxTokens: 500,
    fallback: draft('The deterministic template answer.'),
    promptVersion: '1.0.0',
    promptHash: 'ph',
    inputHash: 'ih-1',
    surface: 'test_surface',
    traceId: 'trace-1',
    provider: new FixtureProvider() as LlmProvider,
    ...over,
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
     VALUES ('rt-run@example.es','x','ES','EUR') RETURNING id`,
  );
  userId = rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM shared_analysis_cache');
  await pool.query('DELETE FROM cost_ledger');
});

describe('FixtureProvider (the deterministic mock)', () => {
  it('returns the fallback verbatim and is byte-identical across calls', async () => {
    const p = new FixtureProvider();
    const req: LlmRequest = {
      tier: 'mid',
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      agent: 'a',
      promptVersion: '1.0.0',
      fallback: draft('canonical output'),
    };
    const a = await p.complete(req);
    const b = await p.complete(req);
    expect(a.text).toBe('canonical output');
    expect(a).toEqual(b);
    expect(a.degraded).toBe(false);
  });

  it('prices higher tiers above lower tiers (deterministic)', () => {
    const p = new FixtureProvider();
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    const small = Number(p.priceEur('fixture-small', usage));
    const mid = Number(p.priceEur('fixture-mid', usage));
    const large = Number(p.priceEur('fixture-large', usage));
    expect(small).toBeLessThan(mid);
    expect(mid).toBeLessThan(large);
  });
});

describe('runAgent — shared-analysis cache (§40)', () => {
  it('misses then hits: second identical Layer-1 call costs nothing and is traced as a hit', async () => {
    const first = await runAgent(pool, baseInput({ userId: null, inputHash: 'sh-1' }));
    expect(first.cacheHit).toBe(false);
    expect(Number(first.costEur)).toBeGreaterThan(0);

    const second = await runAgent(pool, baseInput({ userId: null, inputHash: 'sh-1' }));
    expect(second.cacheHit).toBe(true);
    expect(second.costEur).toBe('0');
    expect(second.text).toBe(first.text);

    const { rows: cache } = await pool.query(`SELECT count(*)::int AS n FROM shared_analysis_cache`);
    expect(cache[0].n).toBe(1);
    const { rows: traces } = await pool.query(
      `SELECT cache_hit FROM agent_messages WHERE agent = 'test.agent' ORDER BY id`,
    );
    expect(traces.map((r) => r.cache_hit)).toEqual([false, true]);
  });

  it('never caches personal (user-scoped) work', async () => {
    await runAgent(pool, baseInput({ userId, inputHash: 'personal-1', surface: 'copilot' }));
    await runAgent(pool, baseInput({ userId, inputHash: 'personal-1', surface: 'copilot' }));
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM shared_analysis_cache`);
    expect(rows[0].n).toBe(0); // §40.4 — contextualizations are never cached
  });
});

describe('runAgent — cost governance (§37.3)', () => {
  it('accrues spend to the user surface ledger', async () => {
    await runAgent(pool, baseInput({ userId, inputHash: 'c-1', surface: 'deep_analysis' }));
    const { rows } = await pool.query(
      `SELECT eur::text FROM cost_ledger WHERE user_id = $1 AND surface = 'deep_analysis'`,
      [userId],
    );
    expect(Number(rows[0].eur)).toBeGreaterThan(0);
  });

  it('over the daily ceiling: degrades to the fallback WITHOUT calling the provider', async () => {
    await addCost(pool, userId, 'copilot', '1.99'); // near the €2/day cap
    const neverCall: LlmProvider = {
      name: 'never',
      modelFor: () => 'x',
      priceEur: () => '0',
      complete: async () => {
        throw new Error('provider must not be called when over the ceiling');
      },
    };
    const res = await runAgent(
      pool,
      baseInput({ userId, inputHash: 'c-2', surface: 'copilot', estCostEur: '0.30', provider: neverCall }),
    );
    expect(res.degraded).toBe(true);
    expect(res.costEur).toBe('0');
    expect(res.text).toBe('The deterministic template answer.');
    const { rows } = await pool.query(
      `SELECT model FROM agent_messages WHERE input_hash = 'c-2'`,
    );
    expect(rows[0].model).toContain('cost_ceiling');
  });
});

describe('runAgent — provider degradation', () => {
  it('a degraded provider response costs nothing, writes no cache, and is traced degraded', async () => {
    const degrading: LlmProvider = {
      name: 'degrading',
      modelFor: () => 'x',
      priceEur: () => '9.99',
      complete: async (req): Promise<LlmResponse> => ({
        text: req.fallback.text,
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'x',
        provider: 'degrading',
        degraded: true,
      }),
    };
    const res = await runAgent(pool, baseInput({ userId: null, inputHash: 'deg-1', provider: degrading }));
    expect(res.degraded).toBe(true);
    expect(res.costEur).toBe('0');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM shared_analysis_cache`);
    expect(rows[0].n).toBe(0);
    const { rows: t } = await pool.query(`SELECT model FROM agent_messages WHERE input_hash = 'deg-1'`);
    expect(t[0].model).toContain('degraded');
  });
});

describe('AnthropicProvider (offline drop-in stub)', () => {
  it('resolves tiers and prices without credentials', () => {
    const p = new AnthropicProvider();
    expect(p.modelFor('large')).toBe('claude-opus-4-8');
    expect(p.modelFor('small')).toBe('claude-haiku-4-5');
    const cost = Number(p.priceEur('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(30, 5); // $5 in + $25 out per MTok
  });

  it('complete() throws a clear, actionable error when unconfigured', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const p = new AnthropicProvider();
    await expect(
      p.complete({
        tier: 'mid',
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 10,
        agent: 'a',
        promptVersion: '1.0.0',
        fallback: draft('t'),
      }),
    ).rejects.toBeInstanceOf(AnthropicProviderNotConfiguredError);
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });
});

describe('provider factory', () => {
  it('defaults to the fixture provider', () => {
    setProviderForTests(null);
    resetProviderCache();
    delete process.env.ATLAS_LLM_PROVIDER;
    expect(getProvider().name).toBe('fixture');
  });

  it('honours ATLAS_LLM_PROVIDER=anthropic', () => {
    setProviderForTests(null);
    resetProviderCache();
    process.env.ATLAS_LLM_PROVIDER = 'anthropic';
    expect(getProvider().name).toBe('anthropic');
    delete process.env.ATLAS_LLM_PROVIDER;
    resetProviderCache();
  });
});

/**
 * A hung provider must not hang the caller (P1-5).
 *
 * Before this there was no timeout and no signal: a provider that never
 * answered held its caller forever — a lease-holding job in a worker, an HTTP
 * handler on the Copilot path.
 */
describe('provider timeout', () => {
  /** Never resolves unless its signal aborts. The failure mode, exactly. */
  class HangingProvider implements LlmProvider {
    readonly name = 'hanging';
    aborted = false;
    modelFor(): string {
      return 'hanging-model';
    }
    priceEur(): string {
      return '0';
    }
    complete(req: LlmRequest): Promise<LlmResponse> {
      return new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          this.aborted = true;
          reject(new Error('aborted'));
        });
      });
    }
  }

  it('degrades to the deterministic template instead of hanging', async () => {
    process.env.ATLAS_LLM_TIMEOUT_MS = '150';
    const provider = new HangingProvider();
    try {
      const started = Date.now();
      const res = await runAgent(
        pool,
        baseInput({ provider, inputHash: `timeout-${Date.now()}` }) as never,
      );
      const elapsed = Date.now() - started;

      expect(res.degraded).toBe(true);
      expect(res.text).toBe('The deterministic template answer.');
      expect(res.model).toBe('degraded:provider_error');
      expect(res.costEur).toBe('0');
      // Bounded: it returned near the timeout, not "eventually".
      expect(elapsed).toBeLessThan(2000);
    } finally {
      delete process.env.ATLAS_LLM_TIMEOUT_MS;
    }
  });

  it('aborts the signal so the provider can free the socket', async () => {
    // Giving up without cancelling leaves the request alive, still costing
    // money and still holding a connection nobody will read.
    process.env.ATLAS_LLM_TIMEOUT_MS = '150';
    const provider = new HangingProvider();
    try {
      await runAgent(pool, baseInput({ provider, inputHash: `abort-${Date.now()}` }) as never);
      expect(provider.aborted).toBe(true);
    } finally {
      delete process.env.ATLAS_LLM_TIMEOUT_MS;
    }
  });

  it('records the timeout as a gap, so a degraded turn is not invisible', async () => {
    process.env.ATLAS_LLM_TIMEOUT_MS = '150';
    const traceId = `trace-timeout-${Date.now()}`;
    try {
      await runAgent(
        pool,
        baseInput({
          provider: new HangingProvider(),
          traceId,
          inputHash: `gap-${Date.now()}`,
        }) as never,
      );
      const { rows } = await pool.query(
        `SELECT model, gaps FROM agent_messages WHERE trace_id = $1`,
        [traceId],
      );
      expect(rows[0].model).toBe('degraded:provider_error');
      expect(JSON.stringify(rows[0].gaps)).toContain('llm timeout');
    } finally {
      delete process.env.ATLAS_LLM_TIMEOUT_MS;
    }
  });

  it('does not fire on a provider that answers in time', async () => {
    process.env.ATLAS_LLM_TIMEOUT_MS = '5000';
    try {
      const res = await runAgent(pool, baseInput({ inputHash: `fast-${Date.now()}` }) as never);
      expect(res.model).not.toBe('degraded:provider_error');
    } finally {
      delete process.env.ATLAS_LLM_TIMEOUT_MS;
    }
  });
});
