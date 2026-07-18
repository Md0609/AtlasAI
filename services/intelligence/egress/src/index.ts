/**
 * @atlas/egress — the SOLE constructor of UserFacingContent (§A3.3/§A4.1).
 *
 * "Exactly one module in the codebase can construct the UserFacingContent
 * type the API layer will serialize, and that module's only public
 * constructor runs the Guard. Lint rule + code review can't be the
 * mechanism; the type system can."
 *
 * UserFacingContent is a class with a PRIVATE constructor and an ECMAScript
 * #private field: TypeScript treats it nominally, so no other module can
 * fabricate a structurally-identical object that type-checks. The
 * architecture tests additionally assert that no module outside this one
 * imports @atlas/guard or constructs the class.
 *
 * Rendering discipline:
 *  - signal spans are FORMATTED, never computed — decimal arithmetic from
 *    @atlas/domain, value straight from the bundle (P4);
 *  - user quotes are verified verbatim against the stored row before
 *    rendering (§6.2 "thesis quote verbatim-matched to stored text");
 *  - the rendered segments (quotes masked) go through the Guard; only an
 *    approved verdict yields a UserFacingContent. Rejection returns the
 *    verdict — the caller's fallback is the deterministic template path,
 *    never a bypass.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type {
  ContextSpan,
  ContextualizationDoc,
  GuardVerdict,
  UserQuoteSource,
} from '@atlas/contracts';
import { dec, fixed } from '@atlas/domain';
import { guardCheck, type LexicalInputSegment } from '@atlas/guard';

// ---------------------------------------------------------------------------
// The branded type
// ---------------------------------------------------------------------------

// A symbol key keeps the factory invisible outside this module: the symbol
// itself is never exported.
const INTERNAL_CREATE: unique symbol = Symbol('egress.create');

export class UserFacingContent {
  // Nominal brand: structural fakes don't type-check against #private state.
  #approved = true;

  private constructor(
    public readonly text: string,
    public readonly sections: Array<{ type: string; text: string }>,
    public readonly guard: GuardVerdict,
    public readonly outputHash: string,
  ) {}

  get isApproved(): boolean {
    return this.#approved;
  }

  /** Module-internal factory — NOT exported. */
  static [INTERNAL_CREATE](
    text: string,
    sections: Array<{ type: string; text: string }>,
    guard: GuardVerdict,
    outputHash: string,
  ): UserFacingContent {
    return new UserFacingContent(text, sections, guard, outputHash);
  }
}

export interface EgressRejection {
  rejected: true;
  verdict: GuardVerdict;
}

export type EgressResult = UserFacingContent | EgressRejection;

export function isRejected(r: EgressResult): r is EgressRejection {
  return (r as EgressRejection).rejected === true;
}

// ---------------------------------------------------------------------------
// Quote verification (§6.2): the user's words must match their stored row.
// ---------------------------------------------------------------------------

export type QuoteVerifier = (source: UserQuoteSource, text: string) => Promise<boolean>;

/** Allow-listed (table, column) pairs — quotes come from the user's own rows
 *  (§28.2) and nowhere else; this list is also the SQL-injection guard. */
const QUOTE_SOURCES: Record<string, string[]> = {
  theses: ['statement'],
  thesis_conditions: ['condition_nl'],
  rules: ['stated_reason', 'removal_reason'],
  decisions: ['reason_free_text'],
  profile_versions: ['change_reason'],
};

export function makePgQuoteVerifier(db: pg.Pool | pg.PoolClient): QuoteVerifier {
  return async (source, text) => {
    const columns = QUOTE_SOURCES[source.table];
    if (!columns || !columns.includes(source.column)) return false;
    const { rows } = await db.query(
      `SELECT ${source.column}::text AS v FROM ${source.table} WHERE id = $1`,
      [source.id],
    );
    if (rows.length === 0 || rows[0].v == null) return false;
    return String(rows[0].v).includes(text);
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = {
  fact: 'Fact',
  tension: 'Tension',
  nuance: 'Nuance',
  countercase: 'The case against',
  unknown: 'What Atlas does not know',
};

function renderSpan(span: ContextSpan, doc: ContextualizationDoc): { text: string; quoted: boolean } {
  if (span.kind === 'text') return { text: span.text, quoted: false };
  if (span.kind === 'user_quote') return { text: `“${span.text}”`, quoted: true };
  const entry = doc.signals[span.signalId];
  if (!entry) return { text: '[unresolved]', quoted: false }; // guard rejects anyway
  const v = dec(entry.value);
  const dp = span.dp ?? 2;
  let text: string;
  switch (span.format) {
    case 'percent':
      text = `${fixed(v.times(100), dp)}%`;
      break;
    case 'currency':
      text = `${fixed(v, dp)} ${entry.currency ?? ''}`.trim();
      break;
    default:
      text = fixed(v, dp);
  }
  return { text, quoted: false };
}

// ---------------------------------------------------------------------------
// Guard-decision recording (§29.1) — persistence is injected so the guard
// and egress stay stateless; the Pg recorder is the production wiring.
// ---------------------------------------------------------------------------

export interface GuardDecisionRecord {
  userId: string | null;
  outputHash: string;
  verdict: GuardVerdict;
  generator: ContextualizationDoc['generator'];
}

export type GuardDecisionRecorder = (record: GuardDecisionRecord) => Promise<void>;

export function makePgGuardRecorder(db: pg.Pool | pg.PoolClient): GuardDecisionRecorder {
  return async (r) => {
    await db.query(`SELECT ensure_guard_decisions_partition(now())`);
    await db.query(
      `INSERT INTO guard_decisions
         (user_id, output_hash, verdict, violations, ruleset_version,
          classifier_version, classifier_score, generator, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        r.userId,
        r.outputHash,
        r.verdict.approved ? 'approved' : 'rejected',
        JSON.stringify(r.verdict.violations),
        r.verdict.rulesetVersion,
        r.verdict.classifierVersion,
        r.verdict.classifierScore,
        JSON.stringify(r.generator),
        r.verdict.latencyMs,
      ],
    );
  };
}

// ---------------------------------------------------------------------------
// The single egress path
// ---------------------------------------------------------------------------

export interface EgressOptions {
  verifyQuote: QuoteVerifier;
  recordDecision: GuardDecisionRecorder;
}

export async function renderUserFacingContent(
  doc: ContextualizationDoc,
  opts: EgressOptions,
): Promise<EgressResult> {
  // 1. Verbatim quote verification, before anything is rendered.
  const quoteViolations: GuardVerdict['violations'] = [];
  for (const section of doc.sections) {
    for (const span of section.spans) {
      if (span.kind === 'user_quote') {
        const ok = await opts.verifyQuote(span.source, span.text);
        if (!ok) {
          quoteViolations.push({
            layer: 'structural',
            code: 'struct.quote_mismatch',
            detail: `quote does not verbatim-match ${span.source.table}.${span.source.column} (${span.source.id})`,
          });
        }
      }
    }
  }

  // 2. Render sections into guard-checkable segments.
  const sections: Array<{ type: string; text: string }> = [];
  const segments: LexicalInputSegment[] = [];
  for (const section of doc.sections) {
    const parts = section.spans.map((s) => renderSpan(s, doc));
    const text = parts.map((p) => p.text).join('');
    sections.push({ type: section.type, text: `${SECTION_LABELS[section.type] ?? section.type}: ${text}` });
    for (const p of parts) segments.push({ text: p.text, quoted: p.quoted });
  }
  const falsifiers = doc.confidence.whatWouldChangeIt.filter((w) => w.trim().length > 0);
  if (falsifiers.length > 0) {
    const text = `What would change this: ${falsifiers.join('; ')}.`;
    sections.push({ type: 'what_would_change_it', text });
    segments.push({ text, quoted: false });
  }
  const fullText = sections.map((s) => s.text).join('\n\n');
  const outputHash = createHash('sha256').update(fullText).digest('hex');

  // 3. The Guard — non-bypassable because this is the only constructor.
  const verdict = guardCheck({ doc, rendered: segments });
  verdict.violations.push(...quoteViolations);
  if (quoteViolations.length > 0) verdict.approved = false;

  // 4. Record the decision either way (§29.1 append-only audit).
  await opts.recordDecision({
    userId: doc.userId || null,
    outputHash,
    verdict,
    generator: doc.generator,
  });

  if (!verdict.approved) return { rejected: true, verdict };
  return UserFacingContent[INTERNAL_CREATE](fullText, sections, verdict, outputHash);
}
