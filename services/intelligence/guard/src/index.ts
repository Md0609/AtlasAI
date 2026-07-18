/**
 * @atlas/guard — the Compliance Guard as a STATELESS LIBRARY (§A3.2/§A3.3):
 * no network, no database, no clock dependency beyond latency measurement.
 * It is invoked in-process by exactly one caller — the egress module, the
 * sole constructor of UserFacingContent — which is what makes it
 * non-bypassable: there is no other path from generated content to a user.
 * (Enforced by the architecture tests, not by convention.)
 *
 * Three layers, cheapest first (§A4.1):
 *   1. structural — schema-level; unprovenanced numerals unrepresentable
 *   2. lexical    — deterministic directive screen, versioned rule set
 *   3. classifier — probabilistic backstop for paraphrase
 *
 * All violations are reported (regeneration in 4b needs the specifics).
 */
import type { ContextualizationDoc, GuardVerdict } from '@atlas/contracts';
import { structuralCheck } from './structural.js';
import { LEXICAL_RULESET_VERSION, lexicalScreen, type LexicalInputSegment } from './lexical.js';
import { CLASSIFIER_VERSION, classifyRecommendation } from './classifier.js';

export interface GuardInput {
  doc: ContextualizationDoc;
  /** The rendered output, segmented so user quotes can be masked (§A4.1). */
  rendered: LexicalInputSegment[];
}

export function guardCheck(input: GuardInput): GuardVerdict {
  const started = performance.now();
  const violations = [
    ...structuralCheck(input.doc),
    ...lexicalScreen(input.rendered),
  ];
  const clf = classifyRecommendation(input.rendered);
  violations.push(...clf.violations);
  return {
    approved: violations.length === 0,
    violations,
    rulesetVersion: LEXICAL_RULESET_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    classifierScore: String(clf.score),
    latencyMs: Math.round(performance.now() - started),
  };
}

export { LEXICAL_RULES, LEXICAL_RULESET_VERSION, lexicalScreen } from './lexical.js';
export type { LexicalInputSegment } from './lexical.js';
export { structuralCheck, textHasNumerals } from './structural.js';
export { CLASSIFIER_THRESHOLD, CLASSIFIER_VERSION, classifyRecommendation } from './classifier.js';
