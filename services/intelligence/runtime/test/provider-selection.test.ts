/**
 * Provider selection must never silently serve the fixture as analysis (P0-1).
 *
 * Traced end to end before the fix, with `ATLAS_LLM_PROVIDER=anthropicc` (a
 * typo) and `NODE_ENV=production`:
 *
 *   provider  = fixture           selected silently by the `: new
 *                                 FixtureProvider()` arm of a ternary
 *   runtime   = degraded: false   the fixture's draft IS its answer
 *   guard     = approved: true, 0 violations
 *   HTTP      = { degraded: false, guard_approved: true }
 *   ledger    = cost debited, with synthetic prices
 *
 * Deterministic template prose reaching a user behind a green guard verdict and
 * a full confidence envelope. §0 and §61.3 exist to prevent precisely that:
 * confidence asserted rather than earned.
 *
 * Two properties are pinned here. The configuration cannot silently pick a mock,
 * and — separately, because the first only covers production — output that no
 * model wrote says so, all the way out of the runtime.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FixtureProvider,
  LlmProviderNotConfiguredError,
  getProvider,
  resetProviderCache,
  setProviderForTests,
} from '../src/index.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetProviderCache();
  setProviderForTests(null);
});

/** Select with an explicit environment, ignoring any cached choice. */
function selectWith(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetProviderCache();
  return getProvider();
}

describe('provider selection', () => {
  it('refuses to start in production with no provider configured', () => {
    // The old default. Silent, and the worst available outcome for this
    // product: template prose presented as reasoned analysis.
    expect(() =>
      selectWith({ NODE_ENV: 'production', ATLAS_LLM_PROVIDER: undefined }),
    ).toThrow(LlmProviderNotConfiguredError);
  });

  it('refuses an unrecognised provider EVERYWHERE, not just in production', () => {
    // A typo is a typo. Failing on the developer's machine is what stops it
    // reaching a deployment; failing only in production is finding out late.
    for (const nodeEnv of ['production', 'development', 'test']) {
      expect(() =>
        selectWith({ NODE_ENV: nodeEnv, ATLAS_LLM_PROVIDER: 'anthropicc' }),
      ).toThrow(/not a known provider/);
    }
  });

  it('treats an empty string as unset rather than as a provider name', () => {
    // `ATLAS_LLM_PROVIDER=` in a shell or a compose file is a common way to
    // "unset" something, and it must not fall through to the mock.
    expect(() => selectWith({ NODE_ENV: 'production', ATLAS_LLM_PROVIDER: '' })).toThrow(
      LlmProviderNotConfiguredError,
    );
  });

  it('keeps the fixture default in development, which is the documented design', () => {
    // §B8 is mock-first. Development must not require credentials.
    const p = selectWith({ NODE_ENV: 'development', ATLAS_LLM_PROVIDER: undefined });
    expect(p).toBeInstanceOf(FixtureProvider);
  });

  it('selects each named provider explicitly', () => {
    expect(selectWith({ NODE_ENV: 'test', ATLAS_LLM_PROVIDER: 'fixture' })).toBeInstanceOf(
      FixtureProvider,
    );
    // Constructing AnthropicProvider does not require a key — it throws on
    // first use instead — so this asserts selection without inventing one.
    expect(selectWith({ NODE_ENV: 'test', ATLAS_LLM_PROVIDER: 'anthropic' })).toBeInstanceOf(
      AnthropicProvider,
    );
  });
});

describe('output that no model wrote says so', () => {
  it('marks the fixture as non-generative while leaving degraded alone', async () => {
    // `degraded` means "the real provider fell back" — a different fact, and
    // the fixture is right to report false. What was missing is any signal that
    // the text is not analysis. Overloading `degraded` would have made every
    // development run look like a failure.
    const fixture = new FixtureProvider();
    expect(fixture.generative).toBe(false);

    const resp = await fixture.complete({
      tier: 'mid',
      system: 'sys',
      messages: [{ role: 'user', content: 'analyse' }],
      maxTokens: 100,
      agent: 'test',
      promptVersion: '1.0.0',
      fallback: { text: 'The deterministic template answer.' },
    });
    expect(resp.degraded).toBe(false);
    expect(resp.generative).toBe(false);
    expect(resp.text).toBe('The deterministic template answer.');
  });

  it('declares the real provider generative', () => {
    expect(new AnthropicProvider().generative).toBe(true);
  });
});
