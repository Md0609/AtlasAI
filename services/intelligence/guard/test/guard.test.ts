/**
 * Compliance Guard unit tests (Phase 4a). The adversarial CI-gate suite
 * lives in evals/adversarial; this file covers the mechanics: each layer in
 * both directions, quote masking, determinism.
 */
import { describe, expect, it } from 'vitest';
import type { ContextualizationDoc } from '@atlas/contracts';
import {
  CLASSIFIER_THRESHOLD,
  guardCheck,
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
