/**
 * Layer 2 — deterministic lexical screen (§21.6 L1 in the PRD's numbering;
 * layer 2 of the §A4.1 three-layer guard).
 *
 * The rule set is code: versioned, reviewed, and every change lands in
 * docs/guard-ruleset-changelog.md (FR-12.3 — counsel reviews this set).
 * Rules run on rendered text with user-quote spans MASKED: the user's own
 * words may contain directives; Atlas's may not (§A4.1).
 */
import type { GuardViolation } from '@atlas/contracts';

export const LEXICAL_RULESET_VERSION = 'lex.v1';

interface LexicalRule {
  code: string;
  description: string;
  pattern: RegExp;
}

/**
 * Every pattern is case-insensitive and anchored to word boundaries where
 * possible. Order is irrelevant — all violations are reported, not just the
 * first (§21.6: regeneration needs the specific violation).
 */
export const LEXICAL_RULES: LexicalRule[] = [
  {
    code: 'lex.directive_second_person',
    description: 'telling the user what to do with a position',
    pattern:
      /\byou\s+(really\s+)?(should|ought to|need to|must|had better|would be wise to)\s+(buy|sell|add|trim|hold|exit|invest|take profits|cut|double down|get in|get out)\b/i,
  },
  {
    code: 'lex.first_person_recommendation',
    description: 'Atlas recommending in the first person',
    pattern: /\b(we|i)\s+(would\s+)?(recommend|suggest|advise)\b/i,
  },
  {
    code: 'lex.imperative_trade_verb',
    description: 'imperative trading instruction at sentence start',
    pattern: /(^|[.!?]\s+)(buy|sell|trim|add|exit|hold|accumulate|dump|short)\b(?!\s+(rating|signal)s?\b)/i,
  },
  {
    code: 'lex.rating',
    description: 'a buy/sell rating — ratings are a rejected feature (§12.3)',
    pattern: /\b(strong\s+)?(buy|sell|hold)\s+rating\b|\b(overweight|underweight)\b/i,
  },
  {
    code: 'lex.price_target',
    description: 'price targets are a lie with a decimal point (§22.2)',
    pattern: /\b(price\s+target|target\s+price|our\s+target|targets?\s+of)\b/i,
  },
  {
    code: 'lex.prediction',
    description: 'predicting price outcomes',
    pattern:
      /\bwill\s+(outperform|underperform|double|triple|soar|rally|crash|tank|beat\s+the\s+market|reach|hit)\b|\b(set|poised|destined)\s+to\s+(soar|rally|double|outperform)\b/i,
  },
  {
    code: 'lex.return_promise',
    description: 'promising or implying assured returns',
    pattern:
      /\bguaranteed\s+(returns?|profits?|gains?)\b|\bcan'?t\s+(lose|miss|go\s+wrong)\b|\brisk[- ]free\s+(return|profit|gain|money)\b|\bsure\s+thing\b/i,
  },
  {
    code: 'lex.entry_exit_call',
    description: 'framing now as the moment to act',
    pattern:
      /\b(compelling|great|perfect|excellent|attractive|ideal|rare)\s+(entry\s+point|buying\s+opportunity|time\s+to\s+(buy|sell|add|invest))\b|\b(now\s+is|this\s+is)\s+the\s+time\s+to\s+(buy|sell|add|invest)\b|\bact\s+now\b/i,
  },
  {
    code: 'lex.urgency',
    description: 'manufactured urgency around an action',
    pattern: /\b(don'?t\s+miss( out)?|before\s+it'?s\s+too\s+late|last\s+chance|while\s+you\s+still\s+can)\b/i,
  },
  {
    code: 'lex.conditional_self_recommendation',
    description: 'recommendation smuggled through a hypothetical self',
    pattern: /\bif\s+i\s+were\s+you\b|\bin\s+your\s+(shoes|position),?\s+i(\s+would|'d)\b|\bpersonally,?\s+i(\s+would|'d)\s+(buy|sell|add|trim)\b/i,
  },
];

/** Segments with user quotes masked out. */
export interface LexicalInputSegment {
  text: string;
  quoted: boolean;
}

export function lexicalScreen(segments: LexicalInputSegment[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const unquoted = segments
    .filter((s) => !s.quoted)
    .map((s) => s.text)
    .join(' ');
  for (const rule of LEXICAL_RULES) {
    const m = unquoted.match(rule.pattern);
    if (m) {
      violations.push({
        layer: 'lexical',
        code: rule.code,
        detail: `${rule.description}: "${m[0]}"`,
      });
    }
  }
  return violations;
}
