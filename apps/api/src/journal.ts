/**
 * The Decision Journal (§11.1 / F-27). "Your reasoning history is a first-class
 * object, not a settings page." A journal is *authored by you* — history happens
 * to you (§10.4). It is a unified, reverse-chronological timeline over the
 * things the user reasoned about and Atlas recorded immutably:
 *
 *   - decisions (incl. the decision to do nothing), with the reason given and
 *     WHO authored it (the user, or a Copilot exchange the user kept — FR-11.6);
 *   - thesis lifecycle (written / falsified / retired / superseded);
 *   - rule lifecycle (set / removed), each with its one-line reason.
 *
 * The entry shape is deliberately memory-ready (§30.2 episodic layer): a stable
 * id, a typed `kind`, a timestamp, a `source`, an optional security, and a link
 * back to the underlying immutable record. The later Memory consolidator and the
 * Weekly Review both read this same episodic stream.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from './auth.js';

export interface JournalEntry {
  id: string;
  kind: 'decision' | 'thesis_written' | 'thesis_falsified' | 'thesis_retired' | 'thesis_superseded' | 'rule_set' | 'rule_removed';
  occurred_at: string;
  security_id: string | null;
  security_name: string | null;
  title: string;
  detail: string;
  /** Who authored it: 'user' | 'copilot' | 'system'. */
  source: string;
  /** Link back to the source record (thread id for copilot decisions, etc.). */
  source_ref: string | null;
}

const THESIS_CLOSE_KIND: Record<string, JournalEntry['kind']> = {
  falsified: 'thesis_falsified',
  retired: 'thesis_retired',
  superseded: 'thesis_superseded',
};

export function registerJournalRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/journal', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { security_id?: string; limit?: string };
    const securityFilter = q.security_id ?? null;
    const limit = Math.min(Number(q.limit ?? 200), 500);
    const args = [user.id, securityFilter];

    const [decisions, thesesCreated, thesesClosed, rulesSet, rulesRemoved] = await Promise.all([
      pool.query(
        `SELECT d.id, d.decided_at AS at, d.action, d.reason_free_text, d.source, d.source_thread_id,
                d.security_id, s.name AS security_name
           FROM decisions d LEFT JOIN securities s ON s.id = d.security_id
          WHERE d.user_id = $1 AND ($2::uuid IS NULL OR d.security_id = $2)`,
        args,
      ),
      pool.query(
        `SELECT t.id, t.created_at AS at, t.statement, t.security_id, s.name AS security_name
           FROM theses t LEFT JOIN securities s ON s.id = t.security_id
          WHERE t.user_id = $1 AND ($2::uuid IS NULL OR t.security_id = $2)`,
        args,
      ),
      pool.query(
        `SELECT t.id, t.status_changed_at AS at, t.status, t.status_reason, t.security_id, s.name AS security_name
           FROM theses t LEFT JOIN securities s ON s.id = t.security_id
          WHERE t.user_id = $1 AND t.status <> 'active' AND t.status_changed_at IS NOT NULL
            AND ($2::uuid IS NULL OR t.security_id = $2)`,
        args,
      ),
      pool.query(
        `SELECT r.id, r.created_at AS at, r.rule_type, r.stated_reason
           FROM rules r WHERE r.user_id = $1 AND $2::uuid IS NULL`,
        args,
      ),
      pool.query(
        `SELECT r.id, r.removed_at AS at, r.rule_type, r.removal_reason
           FROM rules r WHERE r.user_id = $1 AND r.removed_at IS NOT NULL AND $2::uuid IS NULL`,
        args,
      ),
    ]);

    const entries: JournalEntry[] = [];
    for (const d of decisions.rows) {
      entries.push({
        id: `decision:${d.id}`,
        kind: 'decision',
        occurred_at: d.at,
        security_id: d.security_id,
        security_name: d.security_name,
        title: d.action,
        detail: d.reason_free_text,
        source: d.source,
        source_ref: d.source_thread_id,
      });
    }
    for (const t of thesesCreated.rows) {
      entries.push({
        id: `thesis_written:${t.id}`,
        kind: 'thesis_written',
        occurred_at: t.at,
        security_id: t.security_id,
        security_name: t.security_name,
        title: 'Wrote a thesis',
        detail: t.statement,
        source: 'user',
        source_ref: t.id,
      });
    }
    for (const t of thesesClosed.rows) {
      entries.push({
        id: `${THESIS_CLOSE_KIND[t.status]}:${t.id}`,
        kind: THESIS_CLOSE_KIND[t.status] ?? 'thesis_retired',
        occurred_at: t.at,
        security_id: t.security_id,
        security_name: t.security_name,
        title: `Thesis ${t.status}`,
        detail: t.status_reason ?? '',
        source: 'user',
        source_ref: t.id,
      });
    }
    for (const r of rulesSet.rows) {
      entries.push({
        id: `rule_set:${r.id}`,
        kind: 'rule_set',
        occurred_at: r.at,
        security_id: null,
        security_name: null,
        title: `Set a rule (${r.rule_type})`,
        detail: r.stated_reason,
        source: 'user',
        source_ref: r.id,
      });
    }
    for (const r of rulesRemoved.rows) {
      entries.push({
        id: `rule_removed:${r.id}`,
        kind: 'rule_removed',
        occurred_at: r.at,
        security_id: null,
        security_name: null,
        title: `Removed a rule (${r.rule_type})`,
        detail: r.removal_reason ?? '',
        source: 'user',
        source_ref: r.id,
      });
    }

    entries.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
    return reply.send({ data: entries.slice(0, limit) });
  });
}
