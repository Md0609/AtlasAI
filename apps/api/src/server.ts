/**
 * API server assembly. buildServer() is exported for integration tests;
 * index.ts boots it against ATLAS_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import { loadUser, registerAuthRoutes } from './auth.js';
import { registerPortfolioRoutes } from './portfolios.js';
import { registerProfileRoutes } from './profile.js';
import { registerSignalRoutes } from './signals.js';
import { problem } from './http.js';

export async function buildServer(pool: pg.Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  app.decorateRequest('traceId', '');
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    req.traceId = randomUUID();
  });

  app.addHook('preHandler', async (req) => {
    req.user = await loadUser(pool, req);
  });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[${req.traceId}]`, err);
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
  registerSignalRoutes(app, pool);

  return app;
}
