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

  app.get('/healthz', async (_req, reply) => {
    await pool.query('SELECT 1');
    return reply.send({ ok: true });
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
