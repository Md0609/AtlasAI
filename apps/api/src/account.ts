/**
 * Account data portability + erasure (Phase 5, F-31 / US-ACC-01/02 / FR-1.5/1.6).
 *
 *  - GET  /v1/account/export  — everything Atlas holds about you, as machine-
 *    readable JSON or a human-readable HTML document of your own investment
 *    reasoning (§6.6: "full, structured, useful, not a hostile JSON dump").
 *    No friction; available during and after cancellation.
 *  - DELETE /v1/account       — GDPR erasure. Issues a certificate immediately,
 *    schedules the cascading hard-delete (≤30-day SLA), and the erasure worker
 *    completes it (user content hard-deleted, audit log pseudonymized).
 *
 * The export reads only; the destructive half is the worker (account-worker.ts).
 */
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { enqueue } from '@atlas/bus';
import { audit, requireUser } from './auth.js';
import { problem } from './http.js';

/** Grace window before erasure runs (≤30-day SLA). Read per call so a
 *  deployment or test can set it without a rebuild. */
function graceDays(): number {
  return Number(process.env.ATLAS_ERASURE_GRACE_DAYS ?? 30);
}

async function buildExport(pool: pg.Pool, userId: string): Promise<Record<string, unknown>> {
  const q = async (sql: string): Promise<unknown[]> => (await pool.query(sql, [userId])).rows;
  const [
    user,
    profile_versions,
    portfolios,
    positions,
    transactions,
    cash_balances,
    private_assets,
    rules,
    theses,
    thesis_conditions,
    decisions,
    radars,
    briefs,
    suppressions,
    copilot_threads,
    copilot_messages,
    memory_items,
    weekly_reviews,
  ] = await Promise.all([
    q(`SELECT id, email, jurisdiction_code, base_currency, created_at FROM users WHERE id = $1`),
    q(`SELECT * FROM profile_versions WHERE user_id = $1 ORDER BY version`),
    q(`SELECT * FROM portfolios WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT p.* FROM positions p JOIN portfolios pf ON pf.id = p.portfolio_id WHERE pf.user_id = $1`),
    q(`SELECT t.* FROM transactions t JOIN portfolios pf ON pf.id = t.portfolio_id WHERE pf.user_id = $1 ORDER BY t.trade_date`),
    q(`SELECT c.* FROM cash_balances c JOIN portfolios pf ON pf.id = c.portfolio_id WHERE pf.user_id = $1`),
    q(`SELECT a.* FROM private_assets a JOIN portfolios pf ON pf.id = a.portfolio_id WHERE pf.user_id = $1`),
    q(`SELECT * FROM rules WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT * FROM theses WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT tc.* FROM thesis_conditions tc JOIN theses t ON t.id = tc.thesis_id WHERE t.user_id = $1`),
    q(`SELECT * FROM decisions WHERE user_id = $1 ORDER BY decided_at`),
    q(`SELECT * FROM radars WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT id, class, headline, body, tone, created_at, read_at FROM briefs WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT id, class, reason, created_at FROM suppressions WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT * FROM copilot_threads WHERE user_id = $1 ORDER BY created_at`),
    q(`SELECT id, thread_id, role, content, created_at FROM copilot_messages WHERE user_id = $1 ORDER BY created_at`),
    // FR-10.5: memory is exportable (the embedding vector is a derived artifact,
    // not user content, so the readable item is what ships).
    q(`SELECT id, kind, security_id, content, source, source_ref, occurred_at FROM memory_items WHERE user_id = $1 ORDER BY occurred_at`),
    q(`SELECT id, week_start, one_thing, sections, generated_at FROM weekly_reviews WHERE user_id = $1 ORDER BY week_start`),
  ]);
  return {
    exported_at: new Date().toISOString(),
    schema: 'atlas.account-export.v1',
    account: (user as Record<string, unknown>[])[0] ?? null,
    profile_versions,
    portfolios,
    positions,
    transactions,
    cash_balances,
    private_assets,
    rules,
    theses,
    thesis_conditions,
    decisions,
    radars,
    briefs,
    suppressions,
    copilot_threads,
    copilot_messages,
    memory_items,
    weekly_reviews,
  };
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A readable document of the user's own reasoning — the export as an asset (§6.6). */
function renderHtml(data: Record<string, unknown>): string {
  const rows = (k: string): Record<string, unknown>[] => (data[k] as Record<string, unknown>[]) ?? [];
  const acct = (data.account as Record<string, unknown>) ?? {};
  const section = (title: string, body: string) => `<section><h2>${esc(title)}</h2>${body}</section>`;
  const theses = rows('theses')
    .map(
      (t) =>
        `<article><blockquote>${esc(t.statement)}</blockquote>` +
        `<div class="meta">${esc(t.status)} · created ${esc(String(t.created_at).slice(0, 10))}</div></article>`,
    )
    .join('');
  const decisions = rows('decisions')
    .map(
      (d) =>
        `<article><strong>${esc(d.action)}</strong> · ${esc(String(d.decided_at).slice(0, 10))}` +
        `<p>${esc(d.reason_free_text)}</p></article>`,
    )
    .join('');
  const ruleItems = rows('rules')
    .map((r) => `<li><strong>${esc(r.rule_type)}</strong> — “${esc(r.stated_reason)}”</li>`)
    .join('');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Atlas — your record</title><style>` +
    `body{font:16px/1.6 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1c1c1c}` +
    `h1{font-size:28px}h2{margin-top:36px;border-bottom:1px solid #e3e1db;padding-bottom:6px}` +
    `blockquote{margin:0;font-style:italic;border-left:3px solid #16493c;padding-left:14px}` +
    `.meta{color:#6b6b6b;font-size:13px;margin:4px 0 18px}article{margin:14px 0}</style></head><body>` +
    `<h1>Your Atlas record</h1>` +
    `<p class="meta">${esc(acct.email)} · ${esc(acct.jurisdiction_code)} · exported ${esc(String(data.exported_at).slice(0, 10))}</p>` +
    section('Your theses — what you believe and why', theses || '<p>None recorded.</p>') +
    section('Your decisions — and the reasons you gave', decisions || '<p>None recorded.</p>') +
    section('Your rules', ruleItems ? `<ul>${ruleItems}</ul>` : '<p>None set.</p>') +
    `<p class="meta">This document is yours. Full machine-readable data is available as JSON from the same endpoint.</p>` +
    `</body></html>`
  );
}

export function registerAccountRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/account/export', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const format = (req.query as { format?: string }).format ?? 'json';
    const data = await buildExport(pool, user.id);
    if (format === 'html') {
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-disposition', 'attachment; filename="atlas-export.html"')
        .send(renderHtml(data));
    }
    return reply
      .header('content-disposition', 'attachment; filename="atlas-export.json"')
      .send({ data });
  });

  app.delete('/v1/account', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    /**
     * Re-authenticate before an irreversible destruction (P1-2).
     *
     * A session alone used to be enough: a stolen cookie, or a borrowed laptop,
     * destroyed the account and every thesis and decision in it. The typed
     * "DELETE" confirmation is client-side only and proves intent, not
     * identity.
     *
     * This is not the friction §6.6 forbids. What that section rules out is
     * dark patterns and retention offers — persuading someone to stay. Asking
     * who you are protects the user rather than the business, the export stays
     * one unauthenticated click away, and nothing here tries to talk anyone out
     * of leaving.
     */
    const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return problem(
        reply,
        req,
        400,
        'password-required',
        'Enter your password to confirm',
        'Deleting your account is permanent, so Atlas checks it is really you.',
      );
    }
    const { rows: cred } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
      [user.id],
    );
    const ok =
      cred.length > 0 && (await argon2.verify(cred[0].password_hash, parsed.data.password));
    if (!ok) {
      await audit(pool, user.id, 'account.delete.denied', 'user', user.id, req.traceId);
      return problem(reply, req, 401, 'invalid-credentials', 'That password is not correct');
    }

    // Idempotent: a pending request returns the same certificate rather than
    // scheduling a second erasure.
    const existing = await pool.query(
      `SELECT certificate, scheduled_for FROM account_deletions WHERE user_id = $1 AND status = 'requested'`,
      [user.id],
    );
    if (existing.rows.length > 0) {
      return reply.status(202).send({
        data: {
          certificate: existing.rows[0].certificate,
          scheduled_for: existing.rows[0].scheduled_for,
          status: 'requested',
        },
      });
    }

    const certificate = `atlas-erasure-${randomUUID()}`;
    const scheduledFor = new Date(Date.now() + graceDays() * 86_400_000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO account_deletions (user_id, certificate, scheduled_for) VALUES ($1, $2, $3)`,
        [user.id, certificate, scheduledFor.toISOString()],
      );
      // The pending-erasure state lives in account_deletions, NOT users.deleted_at:
      // that column is the SOFT-delete mechanism (§27.3.6), and GDPR hard-delete is
      // deliberately separate. Leaving the account active keeps export available
      // "during and after cancellation" (§6.6) through the grace window.
      await enqueue(client, 'account.erase', user.id, { userId: user.id, certificate }, { runAfter: scheduledFor });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // §6.6: no dark patterns, no retention offer. Just the receipt.
    return reply.status(202).send({
      data: {
        certificate,
        scheduled_for: scheduledFor.toISOString(),
        status: 'requested',
        note: `Your data will be erased by ${scheduledFor.toISOString().slice(0, 10)}. Export remains available until then. This certificate is your proof of request.`,
      },
    });
  });
}
