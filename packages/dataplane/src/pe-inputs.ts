/**
 * Trailing-P/E inputs for strategy inference and the PSA context bundle.
 * Moved from apps/api/profile.ts in Phase 4b so the intelligence plane can
 * assemble the same numbers without importing the API package.
 */
import { dec, str } from '@atlas/domain';
import type { PeInput } from '@atlas/signal-engine';
import type { Db } from './inputs.js';

export async function loadPeInputs(pool: Db, securityIds: string[]): Promise<PeInput[]> {
  if (securityIds.length === 0) return [];
  // P/E = latest adjusted close / latest ttm diluted EPS, same currency only.
  const { rows } = await pool.query(
    `SELECT f.security_id, f.value::text AS eps, f.currency AS eps_ccy,
            p.adjusted_close::text AS close, p.currency AS px_ccy
       FROM (SELECT DISTINCT ON (security_id) security_id, value, currency
               FROM fundamentals
              WHERE metric = 'eps_diluted_ttm' AND security_id = ANY($1)
              ORDER BY security_id, as_of DESC) f
       JOIN (SELECT DISTINCT ON (security_id) security_id, adjusted_close, currency
               FROM price_bars WHERE security_id = ANY($1)
              ORDER BY security_id, bar_date DESC) p
         ON p.security_id = f.security_id`,
    [securityIds],
  );
  const out: PeInput[] = [];
  for (const r of rows) {
    if (r.eps_ccy && r.eps_ccy !== r.px_ccy) continue; // no cross-currency P/E
    const eps = dec(r.eps);
    if (eps.lte(0)) continue;
    out.push({ securityId: r.security_id, pe: str(dec(r.close).div(eps)) });
  }
  return out;
}
