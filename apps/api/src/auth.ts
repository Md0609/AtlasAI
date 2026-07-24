/**
 * Auth (Phase-0 scaffolding carried by Phase 1): email+password with Argon2id
 * (FR-1.1), opaque session token (sha256 at rest), jurisdiction captured and
 * gated at registration (FR-1.3 / FR-1.4 — before any analytical feature).
 *
 * Deliberately deferred pending Phase-0 completion: OAuth, TOTP, managed
 * identity provider (D-015). Documented in docs/adr/ADR-000.
 */
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { problem } from './http.js';

const SESSION_COOKIE = 'atlas_session';
const SESSION_TTL_DAYS = 7;

/**
 * The session cookie is `Secure` by default in production, so the browser
 * refuses to send it over plaintext HTTP. Local development and the test suite
 * run over HTTP, hence the NODE_ENV default; ATLAS_COOKIE_SECURE overrides it
 * explicitly either way (e.g. 'true' when running behind TLS in staging).
 * Read per call so a deployment (or a test) can set it without a rebuild.
 */
function cookieSecure(): boolean {
  return tlsExpected();
}

/**
 * Whether this deployment is expected to be behind TLS. One signal, used by
 * both the session cookie's Secure flag and HSTS — they must never disagree,
 * because a Secure cookie without HSTS and HSTS without a Secure cookie are
 * each half a control.
 */
export function tlsExpected(): boolean {
  return process.env.ATLAS_COOKIE_SECURE !== undefined
    ? process.env.ATLAS_COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';
}

export interface AuthedUser {
  id: string;
  email: string;
  jurisdiction: string;
  baseCurrency: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
    user: AuthedUser | null;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function audit(
  db: pg.Pool | pg.PoolClient,
  actorUserId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  traceId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, trace_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorUserId, action, entityType, entityId, traceId, JSON.stringify(payload)],
  );
}

export async function loadUser(pool: pg.Pool, req: FastifyRequest): Promise<AuthedUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.jurisdiction_code, u.base_currency
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.deleted_at IS NULL`,
    [sha256(token)],
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    email: rows[0].email,
    jurisdiction: rows[0].jurisdiction_code,
    baseCurrency: rows[0].base_currency,
  };
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): AuthedUser | null {
  if (!req.user) {
    problem(reply, req, 401, 'unauthenticated', 'Authentication required');
    return null;
  }
  return req.user;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'password must be at least 10 characters'),
  jurisdiction: z.string().length(2),
  base_currency: z.string().length(3),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

/**
 * Per-IP limits on the credential endpoints. These are the brute-force /
 * credential-stuffing surface: everything else behind them needs a session.
 * Deliberately generous enough for a human who mistypes a password, tight
 * enough that an attacker cannot grind. Overridable per deployment; a
 * multi-instance deployment should move the store to Redis (the plugin
 * supports it) so the limit is global rather than per process.
 */
export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // Read at registration (not module load) so a deployment — or a test — can
  // set the limits before the server is built.
  const LOGIN_LIMIT = Number(process.env.ATLAS_RATE_LIMIT_LOGIN ?? 20);
  const REGISTER_LIMIT = Number(process.env.ATLAS_RATE_LIMIT_REGISTER ?? 10);

  app.post('/v1/auth/register', {
    config: { rateLimit: { max: REGISTER_LIMIT, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', "Check the details below", parsed.error.issues[0]?.message);
    }
    const { email, password, jurisdiction, base_currency } = parsed.data;

    // FR-1.3 / FR-1.4: jurisdiction is captured here, before anything else
    // exists for this user, and gated against the versioned policy table.
    const j = await pool.query('SELECT allowed FROM jurisdictions WHERE code = $1', [
      jurisdiction.toUpperCase(),
    ]);
    if (j.rows.length === 0 || !j.rows[0].allowed) {
      return problem(
        reply,
        req,
        403,
        'jurisdiction-not-supported',
        'Atlas is not available in this jurisdiction yet',
        `Jurisdiction ${jurisdiction.toUpperCase()} is not enabled in the current policy table.`,
      );
    }

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, hash, jurisdiction.toUpperCase(), base_currency.toUpperCase()],
      );
      const userId = rows[0].id as string;
      await audit(pool, userId, 'user.register', 'user', userId, req.traceId, {
        jurisdiction: jurisdiction.toUpperCase(),
      });
      const token = await createSession(pool, userId);
      setSessionCookie(reply, token);
      return reply.status(201).send({ id: userId, email });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return problem(reply, req, 409, 'email-taken', 'An account with this email already exists');
      }
      throw err;
    }
  });

  app.post('/v1/auth/login', {
    config: { rateLimit: { max: LOGIN_LIMIT, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', "Enter your email and password");
    }
    const { rows } = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1 AND deleted_at IS NULL',
      [parsed.data.email],
    );
    const invalid = () => problem(reply, req, 401, 'invalid-credentials', 'Invalid email or password');
    if (rows.length === 0) return invalid();
    const ok = await argon2.verify(rows[0].password_hash, parsed.data.password);
    if (!ok) return invalid();
    const token = await createSession(pool, rows[0].id);
    setSessionCookie(reply, token);
    await audit(pool, rows[0].id, 'user.login', 'user', rows[0].id, req.traceId);
    return reply.send({ id: rows[0].id });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/v1/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return reply.send({
      id: user.id,
      email: user.email,
      jurisdiction: user.jurisdiction,
      base_currency: user.baseCurrency,
    });
  });
}

async function createSession(pool: pg.Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
    [userId, sha256(token), String(SESSION_TTL_DAYS)],
  );
  return token;
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}
