/**
 * Provider selection — the ONE place the app decides which LLM backs the
 * intelligence plane. `ATLAS_LLM_PROVIDER` picks it; switching to production is
 * this env var plus credentials, no code change anywhere else (§B8 mock-first).
 *
 * Selection used to be `name === 'anthropic' ? new AnthropicProvider() : new
 * FixtureProvider()`, which routed EVERY other value — including a typo — to
 * the deterministic fixture, silently. Traced end to end with
 * `ATLAS_LLM_PROVIDER=anthropicc` and `NODE_ENV=production`:
 *
 *   provider  = fixture           (selected silently)
 *   runtime   = degraded: false   (the fixture's draft IS its answer)
 *   guard     = approved: true, 0 violations
 *   HTTP      = { degraded: false, guard_approved: true }
 *   ledger    = cost debited, with synthetic prices
 *
 * Template prose served as reasoned analysis behind a green guard verdict and a
 * full confidence envelope. §0 and §61.3 exist to prevent exactly that:
 * confidence asserted rather than earned.
 *
 * Two rules now:
 *
 *  - An UNRECOGNISED value throws everywhere, development included. A typo is a
 *    typo; failing on the developer's machine is what stops it reaching a
 *    deployment.
 *  - An ABSENT value is the fixture in development and a hard failure in
 *    production. Development running mock-first is the documented design; a
 *    production process that cannot name its provider has no business starting.
 */
import type { LlmProvider } from '../provider.js';
import { FixtureProvider } from './fixture.js';
import { AnthropicProvider } from './anthropic.js';

export type ProviderName = 'fixture' | 'anthropic';

/**
 * Exhaustive by construction: adding a `ProviderName` without a factory here is
 * a compile error rather than a silent fallback to the mock.
 */
const PROVIDERS: Record<ProviderName, () => LlmProvider> = {
  fixture: () => new FixtureProvider(),
  anthropic: () => new AnthropicProvider(),
};

export class LlmProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProviderNotConfiguredError';
  }
}

let override: LlmProvider | null = null;

/** Tests inject a provider directly; production reads the env. */
export function setProviderForTests(p: LlmProvider | null): void {
  override = p;
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (override) return override;
  if (cached) return cached;

  const raw = process.env.ATLAS_LLM_PROVIDER;

  if (raw === undefined || raw === '') {
    if (process.env.NODE_ENV === 'production') {
      throw new LlmProviderNotConfiguredError(
        'ATLAS_LLM_PROVIDER is not set. Refusing to start in production: the ' +
          'default is the deterministic fixture, whose output is indistinguishable ' +
          'from reasoned analysis by the time it reaches the user.',
      );
    }
    cached = new FixtureProvider();
    return cached;
  }

  const make = PROVIDERS[raw as ProviderName];
  if (!make) {
    throw new LlmProviderNotConfiguredError(
      `ATLAS_LLM_PROVIDER="${raw}" is not a known provider. ` +
        `Expected one of: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }
  cached = make();
  return cached;
}

/** Reset the cached provider (after changing env in a test/process). */
export function resetProviderCache(): void {
  cached = null;
}
