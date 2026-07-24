/**
 * Relevance Ranker (§18.3) unit tests: the scoring formula (each term, the
 * subtractive terms, determinism), persona defaults + user overrides, ranking
 * order + tie-break, and weekly-budget enforcement.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dec } from '@atlas/domain';
import type { RelevanceFeatures, RelevanceWeights } from '@atlas/contracts';
import {
  BUDGET_EXEMPT_CLASSES,
  DAILY_CAP_EXEMPT_CLASSES,
  DEFAULT_WEIGHTS,
  WEEKLY_BUDGET,
  enforceWeeklyBudget,
  hasWeeklyBudget,
  isBudgetExempt,
  isDailyCapExempt,
  personaFor,
  rankCandidates,
  resolveWeights,
  scoreRelevance,
  weeklyBudgetFor,
} from '../src/index.js';

const ZERO_FEATURES: RelevanceFeatures = {
  materiality: '0',
  positionWeight: '0',
  thesisLinkage: '0',
  ruleLinkage: '0',
  strategyLinkage: '0',
  novelty: '0',
  actionability: '0',
  noisePrior: '0',
  recentVolume: '0',
};

const UNIT_WEIGHTS: RelevanceWeights = {
  w1: '1', w2: '1', w3: '1', w4: '1', w5: '1', w6: '1', w7: '1', w8: '1', w9: '1',
};

describe('scoreRelevance — the §18.3 formula', () => {
  it('is zero when every feature is zero', () => {
    expect(dec(scoreRelevance(ZERO_FEATURES, DEFAULT_WEIGHTS.unknown)).eq(0)).toBe(true);
  });

  it('sums the seven additive terms and subtracts the two negative terms, verbatim', () => {
    const features: RelevanceFeatures = {
      materiality: '0.5',
      positionWeight: '0.4',
      thesisLinkage: '0.3',
      ruleLinkage: '0.2',
      strategyLinkage: '0.1',
      novelty: '0.6',
      actionability: '0.7',
      noisePrior: '0.8',
      recentVolume: '0.9',
    };
    // With all weights = 1: (.5+.4+.3+.2+.1+.6+.7) − (.8+.9) = 2.8 − 1.7 = 1.1
    expect(dec(scoreRelevance(features, UNIT_WEIGHTS)).eq('1.1')).toBe(true);
  });

  it('applies each weight to its own feature', () => {
    const onlyMateriality: RelevanceFeatures = { ...ZERO_FEATURES, materiality: '1' };
    const w: RelevanceWeights = { ...UNIT_WEIGHTS, w1: '0.42' };
    expect(dec(scoreRelevance(onlyMateriality, w)).eq('0.42')).toBe(true);
  });

  it('noise_prior and recent_volume reduce the score (subtractive)', () => {
    const noisy: RelevanceFeatures = { ...ZERO_FEATURES, materiality: '1', noisePrior: '1' };
    // w1·1 − w8·1 with unit weights = 0
    expect(dec(scoreRelevance(noisy, UNIT_WEIGHTS)).eq('0')).toBe(true);

    const veryNoisy: RelevanceFeatures = { ...ZERO_FEATURES, recentVolume: '1' };
    expect(dec(scoreRelevance(veryNoisy, UNIT_WEIGHTS)).eq('-1')).toBe(true);
  });

  it('is deterministic — identical inputs give byte-identical output', () => {
    const f: RelevanceFeatures = { ...ZERO_FEATURES, materiality: '0.333333333333' };
    const a = scoreRelevance(f, DEFAULT_WEIGHTS.value);
    const b = scoreRelevance(f, DEFAULT_WEIGHTS.value);
    expect(a).toBe(b);
  });
});

describe('configuration is data, not code (§18.3 defaults live in config files)', () => {
  const readConfig = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'));

  it('DEFAULT_WEIGHTS is loaded verbatim from config/persona-weights.json', () => {
    const raw = readConfig('persona-weights.json');
    for (const persona of Object.keys(DEFAULT_WEIGHTS) as Array<keyof typeof DEFAULT_WEIGHTS>) {
      expect(DEFAULT_WEIGHTS[persona]).toEqual(raw[persona]);
    }
  });

  it('WEEKLY_BUDGET is loaded verbatim from config/notification-budgets.json', () => {
    const raw = readConfig('notification-budgets.json');
    for (const persona of Object.keys(WEEKLY_BUDGET) as Array<keyof typeof WEEKLY_BUDGET>) {
      expect(WEEKLY_BUDGET[persona]).toBe(raw[persona]);
    }
  });
});

describe('personas and weight resolution (§18.3)', () => {
  it('derives the persona from stated strategy, then inferred, then unknown', () => {
    expect(personaFor('value', 'quality_growth')).toBe('value');
    expect(personaFor('unknown', 'quality_growth')).toBe('quality_growth');
    expect(personaFor(null, null)).toBe('unknown');
    expect(personaFor('unknown', 'unknown')).toBe('unknown');
  });

  it('every persona has a full default weight set and a weekly budget', () => {
    for (const persona of Object.keys(DEFAULT_WEIGHTS) as Array<keyof typeof DEFAULT_WEIGHTS>) {
      const w = DEFAULT_WEIGHTS[persona];
      expect(Object.keys(w).sort()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9']);
      expect(weeklyBudgetFor(persona)).toBeGreaterThan(0);
    }
  });

  it('persona defaults differ (persona-specific weights)', () => {
    // Passive indexers suppress noise harder than value investors weight materiality.
    expect(dec(DEFAULT_WEIGHTS.passive_index.w8).gt(DEFAULT_WEIGHTS.value.w8)).toBe(true);
    expect(dec(DEFAULT_WEIGHTS.value.w1).gt(DEFAULT_WEIGHTS.passive_index.w1)).toBe(true);
  });

  it('resolveWeights starts from the persona default when there is no override', () => {
    expect(resolveWeights('value')).toEqual(DEFAULT_WEIGHTS.value);
    expect(resolveWeights('value', null)).toEqual(DEFAULT_WEIGHTS.value);
  });

  it('resolveWeights applies user-specific learned overrides on top of the default', () => {
    const merged = resolveWeights('passive_index', { w1: '0.99', w8: '0.01' });
    expect(merged.w1).toBe('0.99'); // overridden
    expect(merged.w8).toBe('0.01'); // overridden
    expect(merged.w2).toBe(DEFAULT_WEIGHTS.passive_index.w2); // untouched → persona default
  });

  it('ignores undefined/null override entries (partial overrides)', () => {
    const merged = resolveWeights('unknown', { w1: '0.5', w2: undefined });
    expect(merged.w1).toBe('0.5');
    expect(merged.w2).toBe(DEFAULT_WEIGHTS.unknown.w2);
  });
});

describe('rankCandidates — deterministic ordering', () => {
  it('orders by score descending', () => {
    const ranked = rankCandidates(
      [
        { id: 'low', features: { ...ZERO_FEATURES, materiality: '0.1' } },
        { id: 'high', features: { ...ZERO_FEATURES, materiality: '0.9' } },
        { id: 'mid', features: { ...ZERO_FEATURES, materiality: '0.5' } },
      ],
      UNIT_WEIGHTS,
    );
    expect(ranked.map((c) => c.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks ties by candidate id ascending (stable, reproducible)', () => {
    const same = { ...ZERO_FEATURES, materiality: '0.5' };
    const ranked = rankCandidates(
      [
        { id: 'ccc', features: same },
        { id: 'aaa', features: same },
        { id: 'bbb', features: same },
      ],
      UNIT_WEIGHTS,
    );
    expect(ranked.map((c) => c.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });
});

describe('enforceWeeklyBudget — §18.3 weekly notification budgets', () => {
  const ranked = rankCandidates(
    [
      { id: 'a', features: { ...ZERO_FEATURES, materiality: '0.9' } },
      { id: 'b', features: { ...ZERO_FEATURES, materiality: '0.6' } },
      { id: 'c', features: { ...ZERO_FEATURES, materiality: '0.3' } },
    ],
    UNIT_WEIGHTS,
  );

  it('delivers the highest-scoring candidates up to the remaining budget', () => {
    const { deliver, suppress } = enforceWeeklyBudget(ranked, 2, 0);
    expect(deliver.map((c) => c.id)).toEqual(['a', 'b']); // top 2 by score
    expect(suppress.map((c) => c.id)).toEqual(['c']); // the rest are suppressed
  });

  it('accounts for interruptions already delivered this week', () => {
    const { deliver, suppress } = enforceWeeklyBudget(ranked, 3, 2); // only 1 slot left
    expect(deliver.map((c) => c.id)).toEqual(['a']);
    expect(suppress.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('suppresses everything when the weekly budget is already spent', () => {
    const { deliver, suppress } = enforceWeeklyBudget(ranked, 3, 3);
    expect(deliver).toEqual([]);
    expect(suppress.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('never yields negative capacity when over budget', () => {
    const { deliver } = enforceWeeklyBudget(ranked, 2, 5); // already over
    expect(deliver).toEqual([]);
  });

  it('hasWeeklyBudget reflects the persona cap', () => {
    expect(hasWeeklyBudget('passive_index', WEEKLY_BUDGET.passive_index - 1)).toBe(true);
    expect(hasWeeklyBudget('passive_index', WEEKLY_BUDGET.passive_index)).toBe(false);
  });
});

describe('class exemptions (§18.4) — the two sets are not the same set', () => {
  it('C0, C1 and C2 are all exempt from the weekly budget (§18.4)', () => {
    // "C0/C1/C2 are budget-exempt because the user asked for them." A rule the
    // user wrote, a thesis condition they declared, a radar they armed.
    expect(isBudgetExempt('C0')).toBe(true);
    expect(isBudgetExempt('C1')).toBe(true);
    expect(isBudgetExempt('C2')).toBe(true);
  });

  it('everything Atlas raises unprompted is budgeted (§18.4)', () => {
    // C3 material event, C4 drift, C5 learning, C6 product.
    for (const cls of ['C3', 'C4', 'C5', 'C6']) {
      expect(isBudgetExempt(cls)).toBe(false);
    }
  });

  it('the 2/day hard cap exempts C0 and nothing else (§18.6)', () => {
    expect(isDailyCapExempt('C0')).toBe(true);
    for (const cls of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) {
      expect(isDailyCapExempt(cls)).toBe(false);
    }
  });

  it('the daily-cap exemption is strictly narrower than the weekly one', () => {
    // The asymmetry is deliberate (§18.4 vs §18.6): a rule breach is never
    // budgeted away, but it still cannot interrupt you three times in a day.
    // Guards against a future "cleanup" that collapses the two sets into one.
    for (const cls of DAILY_CAP_EXEMPT_CLASSES) {
      expect(BUDGET_EXEMPT_CLASSES).toContain(cls);
    }
    expect(DAILY_CAP_EXEMPT_CLASSES.length).toBeLessThan(BUDGET_EXEMPT_CLASSES.length);
  });

  it('an unknown class is budgeted and capped — the safe default is quiet', () => {
    expect(isBudgetExempt('C99')).toBe(false);
    expect(isDailyCapExempt('C99')).toBe(false);
  });
});
