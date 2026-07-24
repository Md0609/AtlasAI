/**
 * The Weekly Review generator (F-25, §6.5) — `weekly_review_generator` in the
 * §25.1 worker table, Sunday, staggered.
 *
 * "The retention engine. Design constraint: it must be worth reading on a week
 * when nothing happened." So every section is computed from real recorded data
 * and reads as work done, not as an empty feed:
 *
 *   1. The one thing        — one sentence, deterministically the highest-priority open item.
 *   2. What changed         — deterministic diff vs. LAST week's stored snapshot.
 *   3. What didn't change   — what Atlas reviewed and what it chose not to send
 *                             (§18.7 / FR-8.3) — "the highest-trust section".
 *   4. Your rules           — adherence, breaches, with the user's own reason quoted.
 *   5. Open questions       — theses whose falsification conditions are met.
 *
 * §6.5 sections 6 (one thing to learn) and 7 (Atlas's scorecard) are NOT built:
 * §A5 cuts Learning Mode to a hover glossary at MVP, and §51.4 defers the
 * Scorecard to v1.1 because claims must age ("shipping '0 claims graded' is
 * worse than not shipping it") while its data capture already ships.
 *
 * The assembled text is narrated behind the Guard with the deterministic
 * template as the permanent degradation path (§B10), exactly like briefs.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { enqueue, type Job } from '@atlas/bus';
import { dec, fixed } from '@atlas/domain';
import { computePortfolioSignals } from '@atlas/signal-engine';
import { loadConsolidatedInputs } from '@atlas/dataplane';
import { narrate, newTraceId } from '@atlas/agents';

export interface ReviewSection {
  type: 'what_changed' | 'what_didnt_change' | 'your_rules' | 'open_questions';
  title: string;
  lines: string[];
}

interface Snapshot {
  total_value_base: string | null;
  base_currency: string;
  cash_weight: string | null;
  effective_n: string | null;
  holdings: number;
}

/** Monday (UTC) of the week containing `d`. */
export function weekStartUtc(d: Date = new Date()): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Mon=0
  day.setUTCDate(day.getUTCDate() - dow);
  return day.toISOString().slice(0, 10);
}

/**
 * The delivery instant for a given review week: the Sunday that CLOSES the week
 * (§6.5 "Sunday morning"), at 06:00 UTC plus a stable per-user offset inside a
 * 6-hour window (§41.6 — the Weekly Review thundering herd is spread, not
 * synchronised).
 */
export function deliveryAtForWeek(userId: string, weekStart: string): Date {
  const d = new Date(Date.parse(`${weekStart}T00:00:00Z`));
  d.setUTCDate(d.getUTCDate() + 6); // Monday-start week ⇒ Sunday closes it
  const bucket = parseInt(createHash('sha1').update(userId).digest('hex').slice(0, 6), 16) % 360; // minutes
  d.setUTCHours(6, 0, 0, 0); // 06:00 baseline
  d.setUTCMinutes(d.getUTCMinutes() + bucket); // spread across 06:00–12:00
  return d;
}

async function buildSnapshot(pool: pg.Pool, userId: string, baseCurrency: string): Promise<Snapshot> {
  const inputs = await loadConsolidatedInputs(pool, userId, baseCurrency);
  const holdings = new Set(inputs.positions.map((p) => p.securityId)).size;
  if (inputs.positions.length === 0 && inputs.cash.length === 0) {
    return { total_value_base: null, base_currency: baseCurrency, cash_weight: null, effective_n: null, holdings };
  }
  const s = computePortfolioSignals(inputs, new Date().toISOString());
  return {
    total_value_base: s.totalValueBase,
    base_currency: s.baseCurrency,
    cash_weight: s.cashWeight,
    effective_n: s.concentration.value.effectiveN,
    holdings,
  };
}

const pct = (v: string): string => `${fixed(dec(v).times(100), 1)}%`;

/** §6.5 §2 — deterministic diff against last week's stored snapshot. */
function whatChanged(prev: Snapshot | null, now: Snapshot): ReviewSection {
  const lines: string[] = [];
  if (!prev) {
    lines.push('This is your first review, so there is nothing to compare it against yet. Next week there will be.');
  } else {
    if (prev.total_value_base && now.total_value_base) {
      const delta = dec(now.total_value_base).minus(prev.total_value_base);
      lines.push(
        delta.isZero()
          ? `Your portfolio value is unchanged at ${fixed(dec(now.total_value_base), 2)} ${now.base_currency}.`
          : `Your portfolio value moved by ${fixed(delta, 2)} ${now.base_currency}, to ${fixed(dec(now.total_value_base), 2)}.`,
      );
    }
    if (prev.cash_weight && now.cash_weight && !dec(prev.cash_weight).eq(now.cash_weight)) {
      lines.push(`Cash weight moved from ${pct(prev.cash_weight)} to ${pct(now.cash_weight)}.`);
    }
    if (prev.holdings !== now.holdings) {
      lines.push(`You now hold ${now.holdings} names, against ${prev.holdings} last week.`);
    }
    if (lines.length === 0) {
      lines.push('Nothing moved in your positions or exposures this week.');
    }
  }
  return { type: 'what_changed', title: 'What changed', lines };
}

export async function handleWeeklyReview(pool: pg.Pool, job: Job): Promise<void> {
  const userId = String(job.payload.userId ?? '');
  if (!userId) throw new Error('weekly.review without userId');
  const { rows: userRows } = await pool.query(
    `SELECT base_currency, email FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (userRows.length === 0) return; // erased or gone: nothing to review, nothing to reschedule
  const baseCurrency = userRows[0].base_currency as string;
  const weekStart = weekStartUtc();

  // Idempotent: one review per user per week, whatever re-runs.
  const existing = await pool.query(`SELECT 1 FROM weekly_reviews WHERE user_id = $1 AND week_start = $2`, [
    userId,
    weekStart,
  ]);
  if (existing.rows.length > 0) return;

  const snapshot = await buildSnapshot(pool, userId, baseCurrency);
  const { rows: prevRows } = await pool.query(
    `SELECT snapshot FROM weekly_reviews WHERE user_id = $1 AND week_start < $2 ORDER BY week_start DESC LIMIT 1`,
    [userId, weekStart],
  );
  const prev = (prevRows[0]?.snapshot ?? null) as Snapshot | null;

  const sections: ReviewSection[] = [whatChanged(prev, snapshot)];

  // §6.5 §3 — what didn't change, and the noise you can ignore (§18.7 / FR-8.3).
  const reviewed = Number(
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM events e
          WHERE e.type = 'security.changed' AND e.recorded_at >= now() - interval '7 days'
            AND e.partition_key IN (
              SELECT DISTINCT po.security_id::text FROM positions po
                JOIN portfolios pf ON pf.id = po.portfolio_id
               WHERE pf.user_id = $1 AND pf.deleted_at IS NULL AND po.security_id IS NOT NULL AND po.quantity <> 0)`,
        [userId],
      )
    ).rows[0].n,
  );
  const { rows: suppressed } = await pool.query(
    `SELECT class, reason, count(*)::int AS n FROM suppressions
      WHERE user_id = $1 AND created_at >= now() - interval '7 days'
      GROUP BY class, reason ORDER BY n DESC`,
    [userId],
  );
  const noise: string[] = [
    reviewed > 0
      ? `Atlas reviewed ${reviewed} update${reviewed === 1 ? '' : 's'} across your holdings this week.`
      : 'Atlas watched your holdings all week and saw no updates worth raising.',
  ];
  if (suppressed.length > 0) {
    const total = suppressed.reduce((n, r) => n + Number(r.n), 0);
    noise.push(`It chose not to interrupt you ${total} time${total === 1 ? '' : 's'}:`);
    for (const s of suppressed) noise.push(`- ${s.n} × ${s.reason}`);
  } else {
    noise.push('Nothing was held back from you this week.');
  }
  sections.push({ type: 'what_didnt_change', title: "What didn't change, and the noise you can ignore", lines: noise });

  // §6.5 §4 — your rules: adherence, breaches, the reason you gave.
  const { rows: ruleRows } = await pool.query(
    `SELECT r.rule_type, r.stated_reason,
            (SELECT e.status FROM rule_evaluations e WHERE e.rule_id = r.id
              ORDER BY e.evaluated_at DESC LIMIT 1) AS status
       FROM rules r WHERE r.user_id = $1 AND r.removed_at IS NULL`,
    [userId],
  );
  const breaches = ruleRows.filter((r) => r.status === 'breach');
  const ruleLines: string[] =
    ruleRows.length === 0
      ? ['You have not set any rules yet.']
      : [
          `${ruleRows.length - breaches.length} of your ${ruleRows.length} rule${ruleRows.length === 1 ? '' : 's'} held this week.`,
          ...breaches.map((b) => `Outside its limit: ${b.rule_type}. When you set it you wrote: "${b.stated_reason}"`),
        ];
  sections.push({ type: 'your_rules', title: 'Your rules', lines: ruleLines });

  // §6.5 §5 — open questions: theses whose falsification conditions are met.
  const { rows: openRows } = await pool.query(
    `SELECT tc.condition_nl, s.name AS security_name
       FROM thesis_conditions tc
       JOIN theses t ON t.id = tc.thesis_id
       LEFT JOIN securities s ON s.id = t.security_id
      WHERE t.user_id = $1 AND t.status = 'active' AND tc.status = 'met'`,
    [userId],
  );
  sections.push({
    type: 'open_questions',
    title: 'Open questions',
    lines:
      openRows.length === 0
        ? ['Nothing you wrote down is currently in question.']
        : openRows.map((o) => `${o.security_name ?? 'Your thesis'}: you said you would be wrong if "${o.condition_nl}". That is now true.`),
  });

  // §6.5 §1 — the one thing. Deterministic priority: a falsified thesis outranks
  // a rule breach, which outranks a quiet week.
  const oneThing =
    openRows.length > 0
      ? `${openRows[0].security_name ?? 'One of your theses'} is the biggest open question in your portfolio: a condition you set for being wrong is now met.`
      : breaches.length > 0
        ? `Your ${breaches[0].rule_type} rule is outside the limit you set for yourself.`
        : 'Nothing in your portfolio needs a decision from you this week.';

  // Narrate behind the Guard; the assembled template is the degradation path (§B10).
  const template = [oneThing, ...sections.map((s) => `${s.title}\n${s.lines.join('\n')}`)].join('\n\n');
  const quoted = [
    ...breaches.map((b) => String(b.stated_reason)),
    ...openRows.map((o) => String(o.condition_nl)),
  ];
  const traceId = newTraceId();
  let narrated = false;
  let model = 'template';
  try {
    const n = await narrate(pool, { userId, surface: 'weekly_review', template, quotedSpans: quoted, traceId });
    narrated = !n.degraded;
    model = n.model;
  } catch {
    /* narration must never block the review — the template stands (§B10) */
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO weekly_reviews (user_id, week_start, one_thing, sections, snapshot, narrated, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, week_start) DO NOTHING
     RETURNING id`,
    [userId, weekStart, oneThing, JSON.stringify(sections), JSON.stringify(snapshot), narrated, model],
  );

  // Email carries the same text. The Weekly Review is a SCHEDULED digest the
  // user is told to expect (§13.3), not an unprompted interruption, so it does
  // not spend from the §18.6 notification budget.
  if (inserted.length > 0) {
    await pool.query(
      `INSERT INTO email_outbox (user_id, to_email, subject, body_text, sent_at)
       VALUES ($1,$2,$3,$4, now())`,
      [userId, userRows[0].email, 'Your week in Atlas', template],
    );
  }
}

/**
 * The `weekly_review_generator` tick (§25.1 — "Sun 06:00 local, staggered").
 *
 * Deliberately a CRON-style sweep that enqueues only jobs that are due RIGHT
 * NOW, rather than a self-perpetuating chain that pre-schedules next Sunday.
 * The queue's per-entity ordering (§24.4) blocks a job whenever an earlier job
 * on the same partition_key is still pending — and that check ignores
 * `run_after` — so parking a far-future job under `partition_key = user_id`
 * would head-of-line block that user's recomputes and briefs until it fired.
 * Enqueuing only when due keeps every queued job immediately runnable.
 *
 * Idempotent: skips users who already have this week's review or a job in
 * flight, so it is safe to call on any interval.
 */
export async function scheduleWeeklyReviews(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const weekStart = weekStartUtc(now);
  const { rows } = await pool.query(`SELECT id FROM users WHERE deleted_at IS NULL`);
  let queued = 0;
  for (const r of rows) {
    const userId = r.id as string;
    if (now < deliveryAtForWeek(userId, weekStart)) continue; // not their slot yet
    const done = await pool.query(`SELECT 1 FROM weekly_reviews WHERE user_id = $1 AND week_start = $2`, [
      userId,
      weekStart,
    ]);
    if (done.rows.length > 0) continue;
    const inFlight = await pool.query(
      `SELECT 1 FROM job_queue WHERE topic = 'weekly.review' AND partition_key = $1
         AND status IN ('pending','processing') LIMIT 1`,
      [userId],
    );
    if (inFlight.rows.length > 0) continue;
    await enqueue(pool, 'weekly.review', userId, { userId }); // runnable now
    queued++;
  }
  return queued;
}
