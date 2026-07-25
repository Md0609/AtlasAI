/**
 * The Copilot stream must survive a client that walks away (P1-4).
 *
 * After reply.hijack() Fastify's error handling no longer applies, and the
 * process has no uncaughtException handler. A user closing the tab mid-stream
 * makes the socket emit ECONNRESET/EPIPE; writing to it throws; and that throw
 * had nowhere to go. One navigation could have taken the API down for everyone.
 *
 * This uses a real listening server, not app.inject(), because inject never
 * produces a broken socket — which is exactly why the gap was invisible.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let base = '';
let cookie = '';
let threadId = '';

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  app = await buildServer(pool);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'sse@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' } as never,
    headers: { 'content-type': 'application/json' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;

  const thread = await app.inject({
    method: 'POST',
    url: '/v1/copilot/threads',
    payload: { context_type: 'global' } as never,
    headers: { 'content-type': 'application/json', cookie },
  });
  threadId = thread.json().data.thread.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const streamUrl = () => `${base}/v1/copilot/threads/${threadId}/stream`;

describe('copilot SSE', () => {
  it('streams a complete answer to a client that stays', async () => {
    const res = await fetch(streamUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'What changed this week?' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: delta');
    expect(body).toContain('event: done');
  });

  it('survives a client that disconnects mid-stream', async () => {
    // Abort as soon as the headers land — the server is mid-write.
    const ac = new AbortController();
    const res = await fetch(streamUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'Abort me' }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    ac.abort();
    await res.body?.cancel().catch(() => {});

    // Give the socket teardown a tick to surface any unhandled throw.
    await new Promise((r) => setTimeout(r, 100));

    // The real assertion: the process is still up and still serving.
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
  });

  it('the aborted turn is still persisted — the stream is a view, not the record', async () => {
    // The turn is written before the first byte, so a dead stream costs the
    // user nothing: the answer is in the thread when they come back.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM copilot_messages WHERE thread_id = $1 AND role = 'assistant'`,
      [threadId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('still serves subsequent streams after a disconnect', async () => {
    const res = await fetch(streamUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'Still working?' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');
  });
});
