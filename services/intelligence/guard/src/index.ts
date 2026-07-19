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

/**
 * guardText — the directive/recommendation screen for NARRATED PROSE (briefs,
 * Reality Check) whose numbers were computed deterministically upstream and
 * carry provenance already. It runs layers 2 and 3 (lexical + classifier) but
 * NOT the structural "numbers must be references" check — that check is for
 * the ContextualizationDoc, where the PSA assembles prose around signal refs.
 * Free-text narration legitimately contains provenanced numerals.
 *
 * This is not a bypass of the doc guard: narrated surfaces have no
 * UserFacingContent to construct; they are template text a model may rephrase,
 * and the one thing that must never leak — a directive/rating/prediction — is
 * exactly what lexical + classifier catch.
 */
export function guardText(rendered: LexicalInputSegment[]): GuardVerdict {
  const started = performance.now();
  const violations = [...lexicalScreen(rendered)];
  const clf = classifyRecommendation(rendered);
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
