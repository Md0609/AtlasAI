/**
 * Event → job routing (§24.2). One place owns which derived work each event
 * class triggers, so the topology diagram in the PRD stays true in code.
 *
 * Ingest emits one market.price.eod per (security, day) — routing collapses
 * them to one security.changed job per distinct security: the recompute
 * reads current state, so N bar events need one recompute, not N (§24.3
 * at-least-once makes over-delivery safe, but not free).
 */
import type { DomainEvent } from '@atlas/contracts';
import { recordEvent, enqueue, type Db } from './index.js';

export async function routeEvents(db: Db, events: DomainEvent[]): Promise<{ jobsEnqueued: number }> {
  const changedSecurities = new Set<string>();
  for (const event of events) {
    await recordEvent(db, event);
    switch (event.type) {
      case 'market.price.eod':
      case 'corporate.action':
        changedSecurities.add(event.securityId);
        break;
      case 'fund.holdings.updated':
        changedSecurities.add(event.fundSecurityId);
        break;
      case 'signal.recomputed':
        break; // consumers enqueue their own follow-ups
    }
  }
  for (const securityId of [...changedSecurities].sort()) {
    await enqueue(db, 'security.changed', securityId, { securityId });
  }
  return { jobsEnqueued: changedSecurities.size };
}
