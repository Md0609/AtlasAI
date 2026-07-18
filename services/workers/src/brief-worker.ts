/**
 * Brief generation + notification dispatch (Phase 3).
 *
 * Briefs are deterministic templates over stored values (§B8: "shippable,
 * not throwaway — remains the degradation path under load/outage forever").
 * Every numeral in a brief is a computed value carried in values_json; no
 * LLM exists anywhere in this path.
 *
 * Dispatch discipline (§24.3, §18.6):
 *   1. dedup-insert (exactly-once user-visible effect) — conflict ⇒ suppress;
 *   2. budget check — C0 is exempt, everything else caps at 2/day, and the
 *      DB trigger enforces it again beneath us;
 *   3. only then: notification rows + email outbox, all one transaction.
 *
 * Tone gate v0 (§18.5, rule-based per Design §A1.1): decumulation users get
 * 'calm' framing when the subject security sits >10% below its 90-day high —
 * never red, lead with information, not urgency. Rule breaches open 'light'
 * ("Heads up") on first occurrence.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { enqueue, type Job } from '@atlas/bus';
import { dec } from '@atlas/domain';

// ---------------------------------------------------------------------------
// brief.generate — {fireId | ruleId+kind:'rule_breach'} + userId
// ---------------------------------------------------------------------------

export async function handleBriefGenerate(pool: pg.Pool, job: Job): Promise<void> {
  const userId = String(job.payload.userId ?? '');
  if (!userId) throw new Error('brief.generate without userId');

  if (job.payload.kind === 'rule_breach') {
    await generateRuleBreachBrief(pool, userId, String(job.payload.ruleId));
    return;
  }
  await generateRadarFireBrief(pool, userId, String(job.payload.fireId));
}

async function generateRadarFireBrief(pool: pg.Pool, userId: string, fireId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT f.id::text AS fire_id, f.observed, f.fired_at, f.brief_id,
            r.id AS radar_id, r.condition_nl, r.source, r.security_id, r.thesis_condition_id,
            s.name AS security_name,
            t.id AS thesis_id, t.statement, t.created_at AS thesis_created_at
       FROM radar_fires f
       JOIN radars r ON r.id = f.radar_id
       LEFT JOIN securities s ON s.id = r.security_id
       LEFT JOIN thesis_conditions tc ON tc.id = r.thesis_condition_id
       LEFT JOIN theses t ON t.id = tc.thesis_id
      WHERE f.id = $1::bigint AND f.user_id = $2`,
    [fireId, userId],
  );
  if (rows.length === 0) throw new Error(`radar fire ${fireId} not found`);
  const fire = rows[0];
  if (fire.brief_id) return; // idempotent: brief already generated

  const observed = fire.observed as { value: string | null; target: string | null };
  const isThesis = fire.source === 'thesis';
  const cls = isThesis ? 'C0' : 'C2';
  const subject = fire.security_name ?? 'your portfolio';

  let headline: string;
  let body: string;
  if (isThesis) {
    const written = String(fire.thesis_created_at).slice(0, 10);
    // §6.2: the thesis quote creates accountability to the user's past self.
    headline = `${subject} — your own falsification condition just fired.`;
    body =
      `On ${written} you wrote: "${fire.statement}"\n\n` +
      `You said you'd be wrong if: "${fire.condition_nl}". That condition is now met — ` +
      `observed ${observed.value ?? '—'} against your threshold of ${observed.target ?? '—'}.\n\n` +
      `Atlas is not telling you what to do. It is telling you that the thing you said would ` +
      `change your mind has happened. Update the thesis, mark it broken, or record why nothing ` +
      `changes — but decide deliberately, not by drift.`;
  } else {
    headline = `${subject} — the thing you asked me to watch for happened.`;
    body =
      `You asked: "${fire.condition_nl}".\n\n` +
      `It happened — observed ${observed.value ?? '—'} against ${observed.target ?? '—'}. ` +
      `No urgency is implied; this is the condition you set, reported once.`;
  }

  const tone = await toneFor(pool, userId, fire.security_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: briefRows } = await client.query(
      `INSERT INTO briefs (user_id, class, radar_fire_id, security_id, headline, body, tone, values_json, provenance)
       VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        userId,
        cls,
        fire.fire_id,
        fire.security_id,
        headline,
        body,
        tone,
        JSON.stringify({ observed: observed.value, target: observed.target }),
        JSON.stringify({ radar_id: fire.radar_id, fire_id: fire.fire_id, observed: fire.observed }),
      ],
    );
    await client.query(`UPDATE radar_fires SET brief_id = $2 WHERE id = $1::bigint`, [
      fire.fire_id,
      briefRows[0].id,
    ]);
    await enqueue(client, 'notify.dispatch', userId, { briefId: briefRows[0].id, userId });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function generateRuleBreachBrief(pool: pg.Pool, userId: string, ruleId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT r.id, r.rule_type, r.stated_reason,
            (SELECT e.observed FROM rule_evaluations e
              WHERE e.rule_id = r.id ORDER BY e.evaluated_at DESC LIMIT 1) AS observed
       FROM rules r WHERE r.id = $1 AND r.user_id = $2 AND r.removed_at IS NULL`,
    [ruleId, userId],
  );
  if (rows.length === 0) return; // rule removed since; nothing to say
  const rule = rows[0];
  const observed = (rule.observed ?? {}) as { value?: string; limit?: string; detail?: string };

  // Idempotency: one C1 brief per rule per breach episode — if the latest
  // brief for this rule is newer than the latest ok-evaluation, skip.
  const { rows: dupRows } = await pool.query(
    `SELECT 1 FROM briefs b
      WHERE b.user_id = $1 AND b.rule_id = $2
        AND b.created_at > COALESCE(
          (SELECT max(e.evaluated_at) FROM rule_evaluations e
            WHERE e.rule_id = $2 AND e.status <> 'breach'), '-infinity'::timestamptz)`,
    [userId, ruleId],
  );
  if (dupRows.length > 0) return;

  // §18.5: rule breach, first occurrence → light. §14.6: the stated reason
  // is quoted back — the quote is the mechanism.
  const headline = `Heads up — you're outside a rule you set.`;
  const body =
    `${observed.detail ?? rule.rule_type}.\n\n` +
    `When you set this rule, you wrote: "${rule.stated_reason}"\n\n` +
    `Nothing is blocked and nothing is urgent. Rules can be changed — deliberately, with a ` +
    `reason — but they shouldn't drift.`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: briefRows } = await client.query(
      `INSERT INTO briefs (user_id, class, rule_id, headline, body, tone, values_json, provenance)
       VALUES ($1,'C1',$2,$3,$4,'light',$5,$6) RETURNING id`,
      [
        userId,
        ruleId,
        headline,
        body,
        JSON.stringify({ value: observed.value ?? null, limit: observed.limit ?? null }),
        JSON.stringify({ rule_id: ruleId, observed }),
      ],
    );
    await enqueue(client, 'notify.dispatch', userId, { briefId: briefRows[0].id, userId });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Tone gate v0 (§18.5): calm for decumulation users in a drawdown context. */
async function toneFor(pool: pg.Pool, userId: string, securityId: string | null): Promise<string> {
  const { rows: prof } = await pool.query(
    `SELECT decumulation FROM profile_versions WHERE user_id = $1 AND valid_to IS NULL`,
    [userId],
  );
  if (!prof[0]?.decumulation) return 'neutral';
  if (!securityId) return 'calm'; // decumulation + portfolio-level event: stay calm
  const { rows } = await pool.query(
    `SELECT (SELECT adjusted_close FROM price_bars WHERE security_id = $1
              ORDER BY bar_date DESC LIMIT 1) AS latest,
            (SELECT max(adjusted_close) FROM price_bars WHERE security_id = $1
              AND bar_date > now()::date - 90) AS high90`,
    [securityId],
  );
  const latest = rows[0]?.latest;
  const high90 = rows[0]?.high90;
  if (latest && high90 && dec(latest).lt(dec(high90).times('0.9'))) return 'calm';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// notify.dispatch — {briefId, userId}
// ---------------------------------------------------------------------------

export async function handleNotifyDispatch(pool: pg.Pool, job: Job): Promise<void> {
  const briefId = String(job.payload.briefId ?? '');
  const userId = String(job.payload.userId ?? '');
  if (!briefId || !userId) throw new Error('notify.dispatch without briefId/userId');

  const { rows } = await pool.query(
    `SELECT b.id, b.class, b.security_id, b.rule_id, b.radar_fire_id, b.headline, b.body,
            u.email
       FROM briefs b JOIN users u ON u.id = b.user_id
      WHERE b.id = $1 AND b.user_id = $2`,
    [briefId, userId],
  );
  if (rows.length === 0) throw new Error(`brief ${briefId} not found`);
  const brief = rows[0];

  // Semantic dedup key (§24.3): class + subject + day. Four re-deliveries of
  // the same story on the same day are one story.
  const subject = brief.security_id ?? brief.rule_id ?? 'portfolio';
  const day = new Date().toISOString().slice(0, 10);
  const dedupKey = createHash('sha256')
    .update(`${brief.class}|${subject}|${day}`)
    .digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dedup = await client.query(
      `INSERT INTO notification_dedup_ledger (user_id, dedup_key)
       VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING dedup_key`,
      [userId, dedupKey],
    );
    if (dedup.rows.length === 0) {
      await client.query(
        `INSERT INTO suppressions (user_id, brief_id, class, reason)
         VALUES ($1,$2,$3,'duplicate: same subject already delivered today (§24.3)')`,
        [userId, briefId, brief.class],
      );
      await client.query('COMMIT');
      return;
    }

    if (brief.class !== 'C0') {
      const { rows: capRows } = await client.query(
        `SELECT count(*)::int AS n FROM notification_budget_ledger
          WHERE user_id = $1 AND day_bucket = $2::date AND class <> 'C0'`,
        [userId, day],
      );
      if (capRows[0].n >= 2) {
        await client.query(
          `INSERT INTO suppressions (user_id, brief_id, class, reason)
           VALUES ($1,$2,$3,'daily cap: 2 non-C0 notifications per day (§18.6)')`,
          [userId, briefId, brief.class],
        );
        await client.query('COMMIT');
        return;
      }
    }

    // Insert-before-send: ledger first (the DB trigger is the backstop).
    await client.query(
      `INSERT INTO notification_budget_ledger (user_id, brief_id, class, day_bucket, week_bucket)
       VALUES ($1,$2,$3,$4::date, date_trunc('week', $4::date)::date)`,
      [userId, briefId, brief.class, day],
    );
    for (const channel of ['in_app', 'email'] as const) {
      await client.query(
        `INSERT INTO notifications (user_id, brief_id, channel, class) VALUES ($1,$2,$3,$4)`,
        [userId, briefId, channel, brief.class],
      );
    }
    await client.query(
      `INSERT INTO email_outbox (user_id, brief_id, to_email, subject, body_text, sent_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [userId, briefId, brief.email, `Atlas — ${brief.headline}`, brief.body],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
