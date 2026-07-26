/**
 * API server assembly. buildServer() is exported for integration tests;
 * index.ts boots it against ATLAS_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import { pendingMigrations } from '@atlas/schema';
import { loadUser, registerAuthRoutes, tlsExpected } from './auth.js';
import { registerBriefRoutes } from './briefs.js';
import { registerContextualizeRoutes } from './contextualize.js';
import { registerCopilotRoutes } from './copilot.js';
import { registerAccountRoutes } from './account.js';
import { registerTodayRoutes } from './today.js';
import { registerJournalRoutes } from './journal.js';
import { registerMemoryRoutes } from './memory.js';
import { registerWeeklyReviewRoutes } from './weekly-review.js';
import { registerPortfolioRoutes } from './portfolios.js';
import { registerProfileRoutes } from './profile.js';
import { registerRadarRoutes } from './radars.js';
import { registerRealityRoutes } from './reality.js';
import { registerRuleRoutes } from './rules.js';
import { registerThesisRoutes } from './theses.js';
import { registerSignalRoutes } from './signals.js';
import { problem } from './http.js';
import { count, loggerOptions, registerObservability } from './observability.js';

export async function buildServer(
  pool: pg.Pool,
  opts: { logStream?: NodeJS.WritableStream } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(opts.logStream),
    /**
     * Let close() wait for in-flight requests (P0-6 / N-6).
     *
     * Measured on Fastify 5.10 with a 1.5s handler and a request in flight:
     *
     *   default (undefined) -> close 2ms,     request dies (UND_ERR_SOCKET)
     *   'idle'              -> close 2ms,     request dies
     *   false               -> close waits,   request completes with 200
     *
     * Both of the first two destroy a connection whose handler is still
     * running: once the request body has been read, Fastify counts the socket
     * as idle even though nobody has answered it yet.
     *
     * `false` is the only setting that finishes the response, and its cost is
     * that idle keep-alive sockets also hold the close open — 71s in the same
     * measurement. That is what the shutdown grace timeout bounds: requests
     * finish, and stragglers stop mattering after ATLAS_SHUTDOWN_GRACE_MS.
     */
    forceCloseConnections: false,
    // The trace_id already returned in every problem+json (§31.5) is now the
    // same id pino stamps on the request, so a user quoting one can be looked up.
    genReqId: () => randomUUID(),
  });
  await app.register(cookie);

  /**
   * Security headers (P0-4). The API shipped with none at all: no CSP, no
   * HSTS, no nosniff, no frame protection.
   *
   * The CSP is written for an app that serves its own SPA from this origin,
   * which is the deployment this is heading for, and it costs nothing while
   * the API only serves JSON. `frame-ancestors 'none'` is the clickjacking
   * fix and is the one directive that matters today, since a framed Atlas plus
   * a session cookie is enough to drive the UI on a user's behalf.
   *
   * No 'unsafe-inline' anywhere: Vite emits an external bundle and an external
   * stylesheet, so nothing here needs it. The HTML account export carries an
   * inline <style>, but it is served Content-Disposition: attachment and is
   * never rendered in this origin, so it is not an exception to make.
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // Only meaningful over TLS, and actively unhelpful on a plaintext dev
    // origin. Keyed to the same signal the session cookie uses.
    hsts: tlsExpected() ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    // Atlas is not a resource other origins should be embedding.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // Leak neither the path nor the query string to third parties.
    referrerPolicy: { policy: 'no-referrer' },
  });
  // Registered non-globally: only the routes that opt in via `config.rateLimit`
  // are limited (today, the credential endpoints — the brute-force surface).
  // Everything else is already behind a session.
  await app.register(rateLimit, { global: false });

  app.decorateRequest('traceId', '');
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.traceId = req.id;
  });

  registerObservability(app, pool);

  app.addHook('preHandler', async (req) => {
    req.user = await loadUser(pool, req);
  });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      count('atlas_unhandled_errors_total');
      req.log.error({ err, traceId: req.traceId }, 'unhandled error');
      // The message is deliberately not echoed: it can carry a query fragment
      // or a column name. The trace_id is how a user and an engineer meet.
      return problem(reply, req, 500, 'internal', 'Internal error', undefined);
    }
    return problem(reply, req, status, 'request-error', (err as Error).message);
  });

  /**
   * Liveness: is this process able to answer at all? Deliberately shallow — a
   * liveness probe that checks dependencies restarts the app when the database
   * blinks, which turns a brief outage into a restart loop.
   */
  app.get('/healthz', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  /**
   * Readiness: should this process receive traffic? Checks what would make its
   * answers wrong rather than merely slow.
   *
   * The migration check is here because of N-4, which was observed rather than
   * theorised: the database ran two migrations behind and every Copilot call
   * returned 500 until someone ran the CLI by hand. A process serving traffic
   * against a schema it does not expect is a subtler outage than one that
   * declines to report ready.
   */
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      await pool.query('SELECT 1');
      checks.database = 'ok';
    } catch (err) {
      checks.database = `unreachable: ${String(err)}`;
      ready = false;
    }

    if (ready) {
      try {
        const pending = await pendingMigrations(pool);
        checks.migrations = pending.length === 0 ? 'ok' : `${pending.length} pending: ${pending.join(', ')}`;
        if (pending.length > 0) ready = false;
      } catch (err) {
        checks.migrations = `unknown: ${String(err)}`;
        ready = false;
      }
    }

    return reply.status(ready ? 200 : 503).send({ ready, checks });
  });

  registerAuthRoutes(app, pool);
  registerPortfolioRoutes(app, pool);
  registerProfileRoutes(app, pool);
  registerRealityRoutes(app, pool);
  registerRuleRoutes(app, pool);
  registerSignalRoutes(app, pool);
  registerThesisRoutes(app, pool);
  registerRadarRoutes(app, pool);
  registerBriefRoutes(app, pool);
  registerContextualizeRoutes(app, pool);
  registerCopilotRoutes(app, pool);
  registerAccountRoutes(app, pool);
  registerTodayRoutes(app, pool);
  registerJournalRoutes(app, pool);
  registerMemoryRoutes(app, pool);
  registerWeeklyReviewRoutes(app, pool);

  return app;
}
