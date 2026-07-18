/**
 * Layer 1 — structural validation of the Contextualization document
 * (§A4.1). This is where "escapes require a failure in the deterministic
 * layers" becomes real:
 *
 *  - text spans may not contain numerals — a number exists only as a signal
 *    reference, so an unprovenanced numeral is unrepresentable (US-AI-02);
 *  - every signal reference must resolve in the bundle;
 *  - confidence.whatWouldChangeIt is required and non-empty (§17.4 — "a
 *    confidence statement without falsifiers is a vibe");
 *  - T1/T2 tensions must anchor to the user's own row (§28.2);
 *  - currency-formatted signals must carry a currency (§27.3.3).
 */
import type { ContextSpan, ContextualizationDoc, GuardViolation } from '@atlas/contracts';

/** Filing names and similar tokens whose digits are nomenclature, not data. */
const NUMERAL_WHITELIST = /\b(10-K|10-Q|8-K|S-1|20-F|6-K)\b/g;

export function textHasNumerals(text: string): boolean {
  return /[0-9]/.test(text.replace(NUMERAL_WHITELIST, ''));
}

function checkSpans(
  spans: ContextSpan[],
  where: string,
  doc: ContextualizationDoc,
  violations: GuardViolation[],
): void {
  for (const span of spans) {
    if (span.kind === 'text') {
      if (textHasNumerals(span.text)) {
        violations.push({
          layer: 'structural',
          code: 'struct.literal_numeral',
          detail: `${where}: literal numeral in prose — numbers must be signal references: "${span.text.slice(0, 80)}"`,
        });
      }
    } else if (span.kind === 'signal') {
      const entry = doc.signals[span.signalId];
      if (!entry) {
        violations.push({
          layer: 'structural',
          code: 'struct.unresolved_signal',
          detail: `${where}: signal reference "${span.signalId}" is not in the bundle`,
        });
      } else if (span.format === 'currency' && !entry.currency) {
        violations.push({
          layer: 'structural',
          code: 'struct.currency_missing',
          detail: `${where}: signal "${span.signalId}" rendered as currency but carries none (§27.3.3)`,
        });
      }
    } else if (span.kind === 'user_quote') {
      if (span.text.trim().length === 0) {
        violations.push({
          layer: 'structural',
          code: 'struct.empty_quote',
          detail: `${where}: empty user quote`,
        });
      }
    }
  }
}

export function structuralCheck(doc: ContextualizationDoc): GuardViolation[] {
  const violations: GuardViolation[] = [];

  if (doc.sections.length === 0) {
    violations.push({ layer: 'structural', code: 'struct.empty', detail: 'no sections' });
  }
  doc.sections.forEach((section, i) => {
    checkSpans(section.spans, `section ${i} (${section.type})`, doc, violations);
    if (section.type === 'tension') {
      if (!section.tensionType) {
        violations.push({
          layer: 'structural',
          code: 'struct.tension_untyped',
          detail: `section ${i}: tension without a §17.3 type`,
        });
      }
      if (
        (section.tensionType === 'T1' || section.tensionType === 'T2') &&
        !section.anchor
      ) {
        violations.push({
          layer: 'structural',
          code: 'struct.tension_unanchored',
          detail: `section ${i}: ${section.tensionType} tension must reference the user's own row (§28.2)`,
        });
      }
      if (section.tensionType === 'T1' && section.anchor && section.anchor.table !== 'rules') {
        violations.push({
          layer: 'structural',
          code: 'struct.tension_wrong_anchor',
          detail: `section ${i}: a T1 (rule) tension must anchor to rules, got ${section.anchor.table}`,
        });
      }
      if (
        section.tensionType === 'T2' &&
        section.anchor &&
        section.anchor.table !== 'theses' &&
        section.anchor.table !== 'thesis_conditions'
      ) {
        violations.push({
          layer: 'structural',
          code: 'struct.tension_wrong_anchor',
          detail: `section ${i}: a T2 (thesis) tension must anchor to theses, got ${section.anchor.table}`,
        });
      }
    }
  });

  if (doc.confidence.whatWouldChangeIt.length === 0 ||
      doc.confidence.whatWouldChangeIt.every((w) => w.trim().length === 0)) {
    violations.push({
      layer: 'structural',
      code: 'struct.no_falsifiers',
      detail: 'confidence.whatWouldChangeIt is empty — a confidence without falsifiers is a vibe (§17.4)',
    });
  }
  checkSpans(doc.confidence.basis, 'confidence.basis', doc, violations);

  return violations;
}
