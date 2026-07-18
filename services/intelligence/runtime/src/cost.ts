/**
 * Per-tenant cost accounting (Phase 4a, §37.3): ceilings are "enforced, not
 * aspirational" — the runtime checks BEFORE spending and degrades to the
 * deterministic path, it never discovers the overrun in the invoice (§42.2).
 *
 * All money is decimal strings (§27.3.2); accumulation happens in SQL
 * numeric arithmetic, never in JS floats.
 */
import type pg from 'pg';
import { dec, str } from '@atlas/domain';

export type Db = pg.Pool | pg.PoolClient;

/** §37.3, verbatim. */
export const COST_CEILINGS = {
  perRequestEur: '1.00',
  perUserDayEur: '2.00',
  perUserMonthEur: '18.00',
} as const;

export async function addCost(
  db: Db,
  userId: string,
  surface: string,
  eur: string,
): Promise<void> {
  if (dec(eur).isNegative()) throw new Error('cost cannot be negative');
  await db.query(
    `INSERT INTO cost_ledger (user_id, day_bucket, surface, eur)
     VALUES ($1, now()::date, $2, $3)
     ON CONFLICT (user_id, day_bucket, surface)
     DO UPDATE SET eur = cost_ledger.eur + EXCLUDED.eur, updated_at = now()`,
    [userId, surface, eur],
  );
}

export interface CostCheck {
  allowed: boolean;
  degrade: boolean;
  reason: string | null;
  spentTodayEur: string;
  spentMonthEur: string;
}

/**
 * Check ceilings before a proposed spend. Per §37.3 the day ceiling degrades
 * (smaller models / deterministic path) rather than hard-failing; only the
 * per-request ceiling is a hard abort.
 */
export async function checkCostCeiling(
  db: Db,
  userId: string,
  proposedEur: string,
): Promise<CostCheck> {
  const { rows } = await db.query(
    `SELECT
       COALESCE(sum(eur) FILTER (WHERE day_bucket = now()::date), 0)::text AS today,
       COALESCE(sum(eur) FILTER (WHERE day_bucket >= date_trunc('month', now())::date), 0)::text AS month
     FROM cost_ledger WHERE user_id = $1`,
    [userId],
  );
  const today = dec(rows[0].today);
  const month = dec(rows[0].month);
  const proposed = dec(proposedEur);

  const base = { spentTodayEur: str(today), spentMonthEur: str(month) };
  if (proposed.gt(COST_CEILINGS.perRequestEur)) {
    return {
      ...base,
      allowed: false,
      degrade: true,
      reason: `single request over the €${COST_CEILINGS.perRequestEur} ceiling — hard abort, degrade (§37.3)`,
    };
  }
  if (month.plus(proposed).gt(COST_CEILINGS.perUserMonthEur)) {
    return {
      ...base,
      allowed: false,
      degrade: true,
      reason: `monthly ceiling €${COST_CEILINGS.perUserMonthEur} reached — degrade and flag for review (§37.3)`,
    };
  }
  if (today.plus(proposed).gt(COST_CEILINGS.perUserDayEur)) {
    return {
      ...base,
      allowed: false,
      degrade: true,
      reason: `daily ceiling €${COST_CEILINGS.perUserDayEur} reached — degrade to smaller models / deterministic (§37.3)`,
    };
  }
  return { ...base, allowed: true, degrade: false, reason: null };
}
