/**
 * Prompt registry (Phase 4a, §38): prompts are code — versioned in the repo,
 * reviewed, released with the deploy, rollback-able. NOT in a database, NOT
 * editable in a UI.
 *
 * Every prompt is composed, not written (§38.2), ordered by volatility so
 * provider-side prefix caching works (§37.2 L5): the cost structure of the
 * product is a function of prompt layout.
 *
 * Registry opinions enforced at registration (§38.4):
 *  - never instruct the model to compute — signals are referenced by name;
 *  - never say "be helpful" — under-specified helpfulness is how a model
 *    talks itself into giving advice;
 *  - the doctrine is explained WITH its reason — models comply better with
 *    constraints they understand.
 */
import { createHash } from 'node:crypto';

export interface PromptSections {
  /** Stable, cacheable: role, epistemic constraints, the §0 doctrine. */
  system: string;
  /** Stable per agent: typed output schema + refusal conditions. */
  contract: string;
  /** Semi-stable placeholder documentation (filled at call time in 4b). */
  context: string;
  /** Volatile, Layer 2 only (§38.2). */
  userContext?: string;
  /** Volatile, short: the actual task template. */
  task: string;
}

export interface PromptDefinition {
  agent: string;
  version: string; // semver per §38.3
  sections: PromptSections;
}

export interface RegisteredPrompt extends PromptDefinition {
  /** sha256 over the composed sections — recorded on every agent message. */
  hash: string;
}

/** §38.4 lint: a prompt that asks the model to do arithmetic is a bug (P4). */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(calculate|compute|do the (math|arithmetic)|work out the number)\b/i, reason: 'prompts must never instruct the model to compute (P4/§21.4)' },
  { pattern: /\bbe helpful\b/i, reason: 'under-specified helpfulness is how a model talks itself into advice (§38.4)' },
];

const registry = new Map<string, RegisteredPrompt>();

export function composePrompt(sections: PromptSections): string {
  return [
    `[SYSTEM]\n${sections.system}`,
    `[CONTRACT]\n${sections.contract}`,
    `[CONTEXT]\n${sections.context}`,
    ...(sections.userContext ? [`[USER CONTEXT]\n${sections.userContext}`] : []),
    `[TASK]\n${sections.task}`,
  ].join('\n\n');
}

export function registerPrompt(def: PromptDefinition): RegisteredPrompt {
  if (!/^\d+\.\d+\.\d+$/.test(def.version)) {
    throw new Error(`prompt ${def.agent}: version must be semver (§38.3), got "${def.version}"`);
  }
  const composed = composePrompt(def.sections);
  for (const rule of FORBIDDEN_PATTERNS) {
    const m = composed.match(rule.pattern);
    if (m) throw new Error(`prompt ${def.agent}@${def.version}: "${m[0]}" — ${rule.reason}`);
  }
  const key = def.agent;
  if (registry.has(key)) {
    throw new Error(`prompt for agent "${def.agent}" already registered — bump the version in place, one active version per agent`);
  }
  const registered: RegisteredPrompt = {
    ...def,
    hash: createHash('sha256').update(composed).digest('hex'),
  };
  registry.set(key, registered);
  return registered;
}

export function getPrompt(agent: string): RegisteredPrompt {
  const p = registry.get(agent);
  if (!p) throw new Error(`no prompt registered for agent "${agent}"`);
  return p;
}

export function allPrompts(): RegisteredPrompt[] {
  return [...registry.values()];
}

/** Test seam: the registry is module state seeded at import time. */
export function clearRegistryForTests(): void {
  registry.clear();
}
