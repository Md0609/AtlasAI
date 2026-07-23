/**
 * Account erasure (Phase 5, F-31 / FR-1.5 / US-ACC-02).
 *
 * GDPR Art. 17: "erasure (30 days, cascading, with a documented exception for
 * the immutable audit log under Art. 17(3)(b), pseudonymized at day 30)"
 * (§35 / line 3818). Two mechanisms, deliberately different (§27.3.6):
 *
 *  - USER CONTENT is hard-deleted, cascading child→parent. This includes the
 *    immutable content tables (theses, decisions, profile versions, copilot
 *    turns): the erasure transaction opts into the controlled exception those
 *    triggers carry (migration 015) by setting `atlas.gdpr_erasure = 'on'`.
 *  - The immutable AUDIT LOG is RETAINED but PSEUDONYMIZED — the PII linkage is
 *    severed (user_id / actor / payload), the rows stay for the audit trail.
 *
 * The whole thing runs in ONE transaction: it either fully erases or rolls back
 * and the job retries. The retained `account_deletions` record — the audit of
 * the erasure itself, disclosed to the user — is marked complete at the end.
 */
import type pg from 'pg';
import type { Job } from '@atlas/bus';

/**
 * Hard-delete of user content, ordered child→parent so foreign keys never
 * block. Each entry is one DELETE scoped to the user (directly by user_id, or
 * transitively through the portfolio / thesis that owns the row).
 */
const HARD_DELETE: Array<[string, string]> = [
  ['notification_feedback', `DELETE FROM notification_feedback WHERE user_id = $1`],
  ['user_notification_prefs', `DELETE FROM user_notification_prefs WHERE user_id = $1`],
  ['copilot_messages', `DELETE FROM copilot_messages WHERE user_id = $1`],
  ['copilot_threads', `DELETE FROM copilot_threads WHERE user_id = $1`],
  ['suppressions', `DELETE FROM suppressions WHERE user_id = $1`],
  ['notifications', `DELETE FROM notifications WHERE user_id = $1`],
  ['notification_budget_ledger', `DELETE FROM notification_budget_ledger WHERE user_id = $1`],
  ['notification_dedup_ledger', `DELETE FROM notification_dedup_ledger WHERE user_id = $1`],
  ['email_outbox', `DELETE FROM email_outbox WHERE user_id = $1`],
  ['decisions', `DELETE FROM decisions WHERE user_id = $1`],
  ['briefs', `DELETE FROM briefs WHERE user_id = $1`],
  ['radar_fires', `DELETE FROM radar_fires WHERE user_id = $1`],
  ['radars', `DELETE FROM radars WHERE user_id = $1`],
  ['thesis_conditions', `DELETE FROM thesis_conditions WHERE thesis_id IN (SELECT id FROM theses WHERE user_id = $1)`],
  ['theses', `DELETE FROM theses WHERE user_id = $1`],
  ['rule_evaluations', `DELETE FROM rule_evaluations WHERE user_id = $1`],
  ['rules', `DELETE FROM rules WHERE user_id = $1`],
  ['transactions', `DELETE FROM transactions WHERE portfolio_id IN (SELECT id FROM portfolios WHERE user_id = $1)`],
  ['positions', `DELETE FROM positions WHERE portfolio_id IN (SELECT id FROM portfolios WHERE user_id = $1)`],
  ['cash_balances', `DELETE FROM cash_balances WHERE portfolio_id IN (SELECT id FROM portfolios WHERE user_id = $1)`],
  ['private_assets', `DELETE FROM private_assets WHERE portfolio_id IN (SELECT id FROM portfolios WHERE user_id = $1)`],
  ['portfolios', `DELETE FROM portfolios WHERE user_id = $1`],
  ['profile_versions', `DELETE FROM profile_versions WHERE user_id = $1`],
  ['relevance_weight_overrides', `DELETE FROM relevance_weight_overrides WHERE user_id = $1`],
  ['cost_ledger', `DELETE FROM cost_ledger WHERE user_id = $1`],
  ['sessions', `DELETE FROM sessions WHERE user_id = $1`],
];

/**
 * Pseudonymization of the retained audit log (Art. 17(3)(b)). Rows stay; the
 * PII linkage is severed. Permitted only because the erasure GUC is set.
 */
const PSEUDONYMIZE: Array<[string, string]> = [
  ['audit_log', `UPDATE audit_log SET actor_user_id = NULL, payload = jsonb_build_object('pseudonymized', true) WHERE actor_user_id = $1`],
  ['agent_messages', `UPDATE agent_messages SET user_id = NULL, output = jsonb_build_object('pseudonymized', true) WHERE user_id = $1`],
  ['guard_decisions', `UPDATE guard_decisions SET user_id = NULL WHERE user_id = $1`],
  ['events', `UPDATE events SET payload = jsonb_build_object('pseudonymized', true) WHERE partition_key = $1`],
];

export async function eraseUser(
  client: pg.PoolClient,
  userId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // Opt into the controlled immutability exception for THIS transaction only.
  await client.query(`SET LOCAL atlas.gdpr_erasure = 'on'`);
  for (const [label, sql] of [...HARD_DELETE, ...PSEUDONYMIZE]) {
    const res = await client.query(sql, [userId]);
    counts[label] = res.rowCount ?? 0;
  }
  const res = await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
  counts['users'] = res.rowCount ?? 0;
  return counts;
}

export async function handleAccountErasure(pool: pg.Pool, job: Job): Promise<void> {
  const userId = String(job.payload.userId ?? '');
  const certificate = String(job.payload.certificate ?? '');
  if (!userId || !certificate) throw new Error('account.erase without userId/certificate');

  // Idempotency: if the record is already completed (a retry after commit),
  // there is nothing left to do — the user rows are gone.
  const { rows: rec } = await pool.query(
    `SELECT status FROM account_deletions WHERE certificate = $1 AND user_id = $2`,
    [certificate, userId],
  );
  if (rec.length === 0) throw new Error(`no deletion record for certificate ${certificate}`);
  if (rec[0].status === 'completed') return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await eraseUser(client, userId);
    // The retained deletion record (no immutability trigger — the completion is
    // itself part of the audit). Marks what was erased, for disclosure.
    await client.query(
      `UPDATE account_deletions SET status = 'completed', completed_at = now(), tables_erased = $2
        WHERE certificate = $1`,
      [certificate, JSON.stringify(counts)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
