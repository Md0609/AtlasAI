/**
 * Compliance Guard unit tests (Phase 4a). The adversarial CI-gate suite
 * lives in evals/adversarial; this file covers the mechanics: each layer in
 * both directions, quote masking, determinism.
 */
import { describe, expect, it } from 'vitest';
import type { ContextualizationDoc } from '@atlas/contracts';
import {
  CLASSIFIER_THRESHOLD,
  classifyRecommendation,
  guardCheck,
  guardText,
  languageScreen,
  lexicalScreen,
  textHasNumerals,
} from '../src/index.js';

function doc(partial: Partial<ContextualizationDoc> = {}): ContextualizationDoc {
  return {
    userId: 'u1',
    subject: { scope: 'security', securityId: 's1' },
    sections: [
      {
        type: 'fact',
        spans: [
          { kind: 'text', text: 'Net-new ARR growth decelerated to ' },
          { kind: 'signal', signalId: 'arr_growth', format: 'percent', dp: 1 },
          { kind: 'text', text: ' this quarter.' },
        ],
      },
    ],
    confidence: {
      level: 'medium',
      basis: [{ kind: 'text', text: 'Based on the filings on record.' }],
      whatWouldChangeIt: ['Next quarter SMB segment disclosure'],
    },
    signals: {
      arr_growth: {
        value: '0.082',
        provenance: {
          engineVersion: '1.0.0',
          inputHash: 'h',
          methodology: 'test',
          inputs: { pricesAsOf: null, fxAsOf: null, holdingsAsOf: null },
        },
      },
    },
    generator: { agent: 'test', promptVersion: 'v1', model: 'none' },
    ...partial,
  };
}

const segments = (text: string, quoted = false) => [{ text, quoted }];

describe('structural layer (§A4.1)', () => {
  it('approves a clean referenced document', () => {
    const v = guardCheck({ doc: doc(), rendered: segments('Net-new ARR growth decelerated to 8.2% this quarter.') });
    // the rendered numeral comes from the renderer; lexical/classifier see no directive
    expect(v.violations.filter((x) => x.layer === 'structural')).toEqual([]);
  });

  it('rejects a literal numeral in prose — unprovenanced numbers are unrepresentable', () => {
    const d = doc();
    d.sections[0]!.spans.push({ kind: 'text', text: 'That is down from 14.1% a year ago.' });
    const v = guardCheck({ doc: d, rendered: [] });
    expect(v.approved).toBe(false);
    expect(v.violations.some((x) => x.code === 'struct.literal_numeral')).toBe(true);
  });

  it('whitelists filing nomenclature (10-K) but not data', () => {
    expect(textHasNumerals('as disclosed in the 10-K')).toBe(false);
    expect(textHasNumerals('as disclosed in the 10-K, revenue was 4.1 billion')).toBe(true);
  });

  it('rejects unresolved signal references and currency-less currency renders', () => {
    const d = doc();
    d.sections[0]!.spans.push({ kind: 'signal', signalId: 'ghost' });
    d.sections[0]!.spans.push({ kind: 'signal', signalId: 'arr_growth', format: 'currency' });
    const v = guardCheck({ doc: d, rendered: [] });
    expect(v.violations.map((x) => x.code)).toContain('struct.unresolved_signal');
    expect(v.violations.map((x) => x.code)).toContain('struct.currency_missing');
  });

  it('rejects missing falsifiers (§17.4) and unanchored T1/T2 tensions (§28.2)', () => {
    const d = doc({
      sections: [
        { type: 'tension', tensionType: 'T1', spans: [{ kind: 'text', text: 'Over your own limit.' }] },
      ],
    });
    d.confidence.whatWouldChangeIt = [];
    const v = guardCheck({ doc: d, rendered: [] });
    expect(v.violations.map((x) => x.code)).toContain('struct.no_falsifiers');
    expect(v.violations.map((x) => x.code)).toContain('struct.tension_unanchored');
  });
});

describe('lexical layer', () => {
  const cases: Array<[string, string]> = [
    ['You should buy more Apple here.', 'lex.directive_second_person'],
    ['We recommend trimming the position.', 'lex.first_person_recommendation'],
    ['Sell before earnings.', 'lex.imperative_trade_verb'],
    ['This is a strong buy rating in all but name.', 'lex.rating'],
    ['Our target price implies meaningful upside.', 'lex.price_target'],
    ['The stock will outperform the index.', 'lex.prediction'],
    ['A guaranteed return at these levels.', 'lex.return_promise'],
    ['This is a compelling entry point for you.', 'lex.entry_exit_call'],
    ["Don't miss out on this one.", 'lex.urgency'],
    ["If I were you, I'd buy today.", 'lex.conditional_self_recommendation'],
  ];
  for (const [text, code] of cases) {
    it(`rejects: "${text}" (${code})`, () => {
      const v = guardCheck({ doc: doc(), rendered: segments(text) });
      expect(v.approved).toBe(false);
      expect(v.violations.map((x) => x.code)).toContain(code);
    });
  }

  it('lets the user say directives in their own quoted words (§A4.1)', () => {
    const v = guardCheck({
      doc: doc(),
      rendered: [
        { text: 'On the day you set this rule you wrote: ', quoted: false },
        { text: 'I should sell when it hits my limit — no exceptions.', quoted: true },
      ],
    });
    expect(v.approved).toBe(true);
  });

  it('passes contextualization language: tension, facts, the §17.3 no-tensions text', () => {
    const clean = [
      'This purchase is consistent with your concentration limits and your stated strategy. That is not a recommendation. It means the decision is yours and nothing in your own rules stands in the way.',
      'Your stated strategy is value; this trades above your usual entry discipline. None of this means the company is bad. It means the purchase is inconsistent with the rules you wrote down.',
      'The deceleration is concentrated in the SMB segment; enterprise held up. What would settle it: the next quarterly segment disclosure.',
    ];
    for (const text of clean) {
      const v = guardCheck({ doc: doc(), rendered: segments(text) });
      expect(v.approved, text).toBe(true);
    }
  });
});

describe('classifier backstop', () => {
  it('catches paraphrase the lexical layer misses', () => {
    const v = guardCheck({
      doc: doc(),
      rendered: segments('Honestly this is a no-brainer — hard to see how you lose money here.'),
    });
    expect(v.approved).toBe(false);
    expect(v.violations.some((x) => x.layer === 'classifier')).toBe(true);
    expect(Number(v.classifierScore)).toBeGreaterThan(CLASSIFIER_THRESHOLD);
  });

  it('reports the score even when approved', () => {
    const v = guardCheck({ doc: doc(), rendered: segments('Nothing changed materially this week.') });
    expect(v.approved).toBe(true);
    expect(Number(v.classifierScore)).toBe(0);
  });
});

describe('determinism', () => {
  it('same input, same verdict (modulo latency)', () => {
    const input = { doc: doc(), rendered: segments('You should buy the dip.') };
    const a = guardCheck(input);
    const b = guardCheck(input);
    expect({ ...a, latencyMs: 0 }).toEqual({ ...b, latencyMs: 0 });
  });
});

/**
 * Layer 0 — the evaluability screen.
 *
 * The English-only rule set is per the PRD (i18n is F-40, v1.1). The defect it
 * fixes is that nothing verified that precondition, so non-English output was
 * approved by silence: every English pattern missed and the Guard reported a
 * pass it had not performed.
 */
describe('language screen (§875 — an escape is an escape in any language)', () => {
  it('refuses to approve a Spanish directive the English rules cannot see', () => {
    // Passes every lexical rule and scores 0 on the classifier — which is
    // exactly the problem. Before layer 0 this was approved.
    const spanish = 'Deberías vender Microsoft ahora mismo, porque está muy caro.';
    expect(lexicalScreen(segments(spanish))).toEqual([]);
    expect(classifyRecommendation(segments(spanish)).score).toBe(0);

    const v = guardCheck({ doc: doc(), rendered: segments(spanish) });
    expect(v.approved).toBe(false);
    expect(v.violations.some((x) => x.code === 'lang.not_evaluable')).toBe(true);
  });

  it.each([
    ['German', 'Sie sollten diese Position verkaufen, denn das ist nicht sehr gut.'],
    ['French', 'Vous devriez vendre cette position, mais aussi faire attention.'],
    ['Portuguese', 'Você não deve comprar mais isso, está muito caro.'],
    ['Italian', 'Questo non è anche della stessa qualità che sono.'],
  ])('refuses %s output as unevaluable', (_lang, text) => {
    const v = guardCheck({ doc: doc(), rendered: segments(text) });
    expect(v.approved).toBe(false);
    expect(v.violations.some((x) => x.code === 'lang.not_evaluable')).toBe(true);
  });

  it('approves ordinary English prose — the screen must not fire on the happy path', () => {
    const v = guardCheck({
      doc: doc(),
      rendered: segments(
        'Your concentration in this position has risen because the price moved, ' +
          'not because you bought more of it. Nothing here needs a decision today.',
      ),
    });
    expect(v.approved).toBe(true);
  });

  it('does not trip on foreign SECURITY NAMES inside English prose', () => {
    // The likeliest false positive, and the one that would degrade real output:
    // European holdings are named in European languages.
    const v = guardCheck({
      doc: doc(),
      rendered: segments(
        'Your largest holdings are Telefónica de España, Société Générale, ' +
          'Banco Santander and La Caixa, and together they are 31% of the portfolio.',
      ),
    });
    expect(v.approved).toBe(true);
  });

  it("leaves the user's own words alone — a Spanish thesis is the user's prose, not Atlas's", () => {
    // Quoted spans are masked from every layer for this exact reason (§A4.1).
    const v = guardCheck({
      doc: doc(),
      rendered: [
        { text: 'When you wrote this thesis you said: ', quoted: false },
        { text: 'Compro porque el negocio es muy bueno y tiene mucho margen.', quoted: true },
        { text: ' That condition has now been met.', quoted: false },
      ],
    });
    expect(v.approved).toBe(true);
  });

  it('rejects long prose with no English grammar in it at all', () => {
    const v = guardCheck({
      doc: doc(),
      rendered: segments('Lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor incididunt labore.'),
    });
    expect(v.approved).toBe(false);
    expect(v.violations.some((x) => x.code === 'lang.not_evaluable')).toBe(true);
  });

  it('stays quiet on short fragments, where detection would be guesswork', () => {
    expect(languageScreen(segments('Up 3%.'))).toEqual([]);
    expect(languageScreen(segments(''))).toEqual([]);
  });
});


/**
 * Approval is not evidence that a model reasoned (P0-1).
 *
 * Every degradation path — provider error, timeout, cost ceiling, numeral drift
 * — returns the caller's deterministic template. That template is compliant by
 * construction: no directive, no rating, no price target. So the Guard approves
 * it, correctly. The point is that `approved` and `a model wrote this` are
 * independent facts which travel separately, and a reader who conflates them
 * gets a degraded turn exactly backwards.
 */
describe('guard approval says nothing about who wrote the text', () => {
  it('approves the deterministic template a degradation returns', () => {
    const template = 'Your concentration in this position rose because the price moved.';
    const verdict = guardText(segments(template));
    expect(verdict.approved).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it('applies the same rules to model prose and to template prose', () => {
    // A directive is rejected wherever it comes from; the Guard has no notion
    // of provenance and must not grow one.
    const directive = 'You should sell this position now.';
    expect(guardText(segments(directive)).approved).toBe(false);
  });
});
