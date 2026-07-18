/**
 * Layer 3 — recommendation classifier, the probabilistic backstop (§A4.1).
 *
 * v0 is a deterministic weighted-cue heuristic behind the same interface a
 * trained classifier (or cross-family LLM judge, §21.6 L4) will implement in
 * Phase 4b+. The guard's guarantee does NOT rest on this layer — escapes
 * already require a failure in the deterministic layers; this catches
 * paraphrase the lexical rules miss.
 *
 * Threshold per §21.6: p(recommendation) > 0.15 rejects.
 */
import type { GuardViolation } from '@atlas/contracts';
import type { LexicalInputSegment } from './lexical.js';

export const CLASSIFIER_VERSION = 'heuristic.v0';
export const CLASSIFIER_THRESHOLD = 0.15;

interface Cue {
  pattern: RegExp;
  weight: number;
  label: string;
}

const CUES: Cue[] = [
  { pattern: /\bno[- ]brainer\b/i, weight: 0.5, label: 'no-brainer framing' },
  { pattern: /\bload\s+up\b|\bback\s+up\s+the\s+truck\b/i, weight: 0.6, label: 'accumulation slang' },
  { pattern: /\bget\s+in\s+(early|now|before)\b/i, weight: 0.5, label: 'entry urging' },
  { pattern: /\byou'?ll\s+thank\s+(yourself|me)\b/i, weight: 0.4, label: 'future-gratitude framing' },
  { pattern: /\bhard\s+to\s+see\s+how\s+you\s+lose\b/i, weight: 0.6, label: 'implied downside denial' },
  { pattern: /\blooks?\s+(really\s+)?(cheap|attractive)\s+(here|right\s+now|at\s+these\s+levels)\b/i, weight: 0.3, label: 'valuation call framed as timing' },
  { pattern: /\bopportunity\s+(of|you)\b/i, weight: 0.2, label: 'opportunity framing' },
  { pattern: /\bsmart\s+money\s+is\b/i, weight: 0.4, label: 'herding cue' },
  { pattern: /\beveryone\s+is\s+(buying|selling)\b/i, weight: 0.4, label: 'herding cue' },
  { pattern: /\bwise\s+to\s+(buy|sell|add|trim|wait)\b/i, weight: 0.3, label: 'wisdom framing of an action' },
  { pattern: /\bdeserves?\s+a\s+(spot|place)\s+in\s+your\s+portfolio\b/i, weight: 0.6, label: 'placement recommendation' },
  { pattern: /\bthe\s+move\s+here\s+is\b/i, weight: 0.5, label: 'prescribing "the move"' },
];

export interface ClassifierResult {
  score: number;
  violations: GuardViolation[];
}

export function classifyRecommendation(segments: LexicalInputSegment[]): ClassifierResult {
  const unquoted = segments
    .filter((s) => !s.quoted)
    .map((s) => s.text)
    .join(' ');
  let score = 0;
  const hits: string[] = [];
  for (const cue of CUES) {
    if (cue.pattern.test(unquoted)) {
      score += cue.weight;
      hits.push(cue.label);
    }
  }
  score = Math.min(1, Number(score.toFixed(4)));
  const violations: GuardViolation[] =
    score > CLASSIFIER_THRESHOLD
      ? [
          {
            layer: 'classifier',
            code: 'clf.recommendation_likely',
            detail: `p(recommendation) ${score} > ${CLASSIFIER_THRESHOLD}: ${hits.join(', ')}`,
          },
        ]
      : [];
  return { score, violations };
}
