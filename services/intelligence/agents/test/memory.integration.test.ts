/**
 * Memory — hybrid retrieval (F-30, §30, FR-10). The load-bearing properties:
 * structured facts are ALWAYS present and NEVER evicted (D-013), semantic recall
 * ranks by similarity × recency and is what gets evicted under the token budget,
 * and one user's memory can never reach another's bundle (FR-10.6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import { getEmbedder, type LlmProvider, type LlmResponse } from '@atlas/runtime';
import { answerCopilot, rememberExchange, retrieveMemory, type CopilotContext } from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let alice = '';
let bob = '';
let securityId = '';

const mkUser = async (email: string): Promise<string> =>
  (
    await pool.query(
      `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
       VALUES ($1,'x','ES','EUR') RETURNING id`,
      [email],
    )
  ).rows[0].id;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  alice = await mkUser('alice-mem@example.es');
  bob = await mkUser('bob-mem@example.es');
  securityId = (
    await pool.query(
      `INSERT INTO securities (name, type, is_fund, currency) VALUES ('Adobe Inc','equity',false,'USD') RETURNING id`,
    )
  ).rows[0].id;

  // Alice's STRUCTURED facts (the moat — live tables, never embedded).
  await pool.query(
    `INSERT INTO rules (user_id, rule_type, params, stated_reason)
     VALUES ($1,'max_single_name','{"limit":"0.15"}'::jsonb,'I will not let one name sink me.')`,
    [alice],
  );
  await pool.query(
    `INSERT INTO theses (user_id, security_id, statement, status)
     VALUES ($1,$2,'Services revenue makes Adobe a compounder.','active')`,
    [alice, securityId],
  );
  await pool.query(
    `INSERT INTO decisions (user_id, security_id, action, reason_free_text)
     VALUES ($1,$2,'no_change','Thesis intact, so I am doing nothing.')`,
    [alice, securityId],
  );

  // Alice's SEMANTIC memory (episodic free text).
  await rememberExchange(pool, {
    userId: alice,
    securityId,
    content: 'Q: what about the subscription pricing change\nA: subscription pricing affects the services mix',
    sourceRef: null,
  });
  await rememberExchange(pool, {
    userId: alice,
    content: 'Q: how is my currency exposure\nA: your foreign currency weight is unhedged',
  });
  // Bob's memory — must never surface for Alice (FR-10.6).
  await rememberExchange(pool, { userId: bob, content: 'Q: bob secret holding\nA: bob private matter' });
});

afterAll(async () => {
  await pool.end();
});

describe('hybrid retrieval (§30.3)', () => {
  it('always returns the structured facts, whatever the query', async () => {
    const bundle = await retrieveMemory(pool, { userId: alice, query: 'something totally unrelated' });
    const kinds = bundle.structured.map((s) => s.kind);
    expect(kinds).toContain('rule');
    expect(kinds).toContain('thesis');
    expect(kinds).toContain('decision');
    // The user's hard constraint is present verbatim — never a cosine gamble.
    expect(bundle.text).toContain('I will not let one name sink me.');
  });

  it('ranks semantically relevant recall first', async () => {
    const bundle = await retrieveMemory(pool, { userId: alice, query: 'subscription pricing' });
    expect(bundle.semantic.length).toBeGreaterThan(0);
    expect(bundle.semantic[0]!.content).toContain('subscription pricing');
    expect((bundle.semantic[0]!.similarity ?? 0)).toBeGreaterThan(0);
  });

  it('is strictly tenant-isolated — Bob never appears in Alice\'s bundle (FR-10.6)', async () => {
    const bundle = await retrieveMemory(pool, { userId: alice, query: 'bob secret holding' });
    expect(bundle.text).not.toContain('bob');
    expect(bundle.semantic.every((m) => !m.content.includes('bob'))).toBe(true);
    // And the reverse: Bob sees only his own.
    const bobBundle = await retrieveMemory(pool, { userId: bob, query: 'subscription pricing' });
    expect(bobBundle.text).not.toContain('subscription pricing change');
  });

  it('evicts semantic memory under the token budget but never the structured facts (D-013)', async () => {
    const tight = await retrieveMemory(pool, { userId: alice, query: 'subscription pricing', tokenBudget: 1 });
    expect(tight.semantic).toHaveLength(0); // evicted first
    expect(tight.structured.length).toBeGreaterThan(0); // pinned, survives
    expect(tight.text).toContain('I will not let one name sink me.');
  });

  it('scopes structured recall to a security when one is given', async () => {
    const other = (
      await pool.query(
        `INSERT INTO securities (name, type, is_fund, currency) VALUES ('Other Co','equity',false,'USD') RETURNING id`,
      )
    ).rows[0].id;
    const bundle = await retrieveMemory(pool, { userId: alice, query: 'anything', securityId: other });
    // Adobe's thesis is not about this security; the portfolio-level rule still is.
    expect(bundle.text).not.toContain('Adobe a compounder');
    expect(bundle.text).toContain('I will not let one name sink me.');
  });
});

describe('injection into agent context (FR-10.3)', () => {
  it('puts the retrieved memory in the system prompt the model actually receives', async () => {
    let seenSystem = '';
    const capturing: LlmProvider = {
      name: 'capture',
      modelFor: () => 'capture-mid',
      priceEur: () => '0',
      complete: async (req): Promise<LlmResponse> => {
        seenSystem = req.system;
        return {
          text: req.fallback.text,
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'capture-mid',
          provider: 'capture',
          degraded: false,
        };
      },
    };
    const context: CopilotContext = {
      type: 'security',
      ref: securityId,
      title: 'Adobe Inc',
      preamble: 'You are looking at Adobe Inc.',
      allowedNumerals: [],
      quotedSpans: [],
    };
    await answerCopilot(pool, {
      userId: alice,
      baseCurrency: 'EUR',
      context,
      history: [],
      userMessage: 'subscription pricing',
      provider: capturing,
    });

    // The user's hard constraint (structured, pinned) and the relevant past
    // exchange (semantic) both reached the model.
    expect(seenSystem).toContain('MEMORY');
    expect(seenSystem).toContain('I will not let one name sink me.');
    expect(seenSystem).toContain('subscription pricing');
  });
});

describe('the embedder is deterministic (§B8 mock-first)', () => {
  it('produces identical vectors for identical text', async () => {
    const e = getEmbedder();
    expect(await e.embed('the services mix')).toEqual(await e.embed('the services mix'));
  });
});
