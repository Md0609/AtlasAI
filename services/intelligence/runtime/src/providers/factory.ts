/**
 * Provider selection — the ONE place the app decides which LLM backs the
 * intelligence plane. `ATLAS_LLM_PROVIDER` picks it; default is the
 * deterministic fixture (§B8 mock-first). Switching to production is this env
 * var plus credentials — no code change anywhere else.
 */
import type { LlmProvider } from '../provider.js';
import { FixtureProvider } from './fixture.js';
import { AnthropicProvider } from './anthropic.js';

export type ProviderName = 'fixture' | 'anthropic';

let override: LlmProvider | null = null;

/** Tests inject a provider directly; production reads the env. */
export function setProviderForTests(p: LlmProvider | null): void {
  override = p;
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (override) return override;
  if (cached) return cached;
  const name = (process.env.ATLAS_LLM_PROVIDER ?? 'fixture') as ProviderName;
  cached = name === 'anthropic' ? new AnthropicProvider() : new FixtureProvider();
  return cached;
}

/** Reset the cached provider (after changing env in a test/process). */
export function resetProviderCache(): void {
  cached = null;
}
