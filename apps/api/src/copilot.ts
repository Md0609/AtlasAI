/**
 * Copilot API (§11.2). The Copilot is ambient: a thread is opened FROM a place
 * in the app (a security, a portfolio, a notification), and the server loads
 * that context so the very first turn already knows what the user is looking
 * at. The user never restates their context.
 *
 * Threads are conversation history (the dedicated Copilot page lists them);
 * every turn is generated through @atlas/agents (provider-agnostic, guarded by
 * egress, personal → never cached). Assistant turns can be streamed over SSE.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  answerCopilot,
  buildCopilotContext,
  CopilotContextError,
  rememberExchange,
  type CopilotContext,
  type CopilotContextRef,
} from '@atlas/agents';
import { requireUser } from './auth.js';
import { problem } from './http.js';

const createSchema = z.object({
  context_type: z.enum(['security', 'portfolio', 'notification', 'global']),
  context_ref: z.string().uuid().nullish(),
});

const messageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

interface ThreadRow {
  id: string;
  title: string;
  context_type: CopilotContext['type'];
  context_ref: string | null;
  created_at: string;
  last_message_at: string;
}

async function ownedThread(pool: pg.Pool, userId: string, id: string): Promise<ThreadRow | null> {
  const { rows } = await pool.query(
    `SELECT id, title, context_type, context_ref, created_at, last_message_at
       FROM copilot_threads WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

async function loadHistory(
  pool: pg.Pool,
  threadId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { rows } = await pool.query(
    `SELECT role, content FROM copilot_messages WHERE thread_id = $1 ORDER BY created_at, id`,
    [threadId],
  );
  return rows;
}

async function insertMessage(
  db: pg.Pool | pg.PoolClient,
  threadId: string,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
  meta?: {
    model: string;
    traceId: string;
    degraded: boolean;
    generative: boolean;
    guardApproved: boolean;
  },
): Promise<{ id: string; created_at: string }> {
  const { rows } = await db.query(
    `INSERT INTO copilot_messages
       (thread_id, user_id, role, content, model, trace_id, degraded, generative, guard_approved)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
    [
      threadId,
      userId,
      role,
      content,
      meta?.model ?? null,
      meta?.traceId ?? null,
      meta?.degraded ?? false,
      // A user's own message is not model-written either, and neither is a turn
      // with no metadata. Defaulting to false claims less, which is the safe
      // direction for a provenance flag.
      meta?.generative ?? false,
      meta?.guardApproved ?? true,
    ],
  );
  await db.query(`UPDATE copilot_threads SET last_message_at = now() WHERE id = $1`, [threadId]);
  return rows[0];
}

/**
 * Persist a material exchange as episodic memory (FR-10.1) so future turns and
 * other surfaces can retrieve it. The subject is the thread's bound security
 * when it has one.
 */
async function rememberTurn(
  pool: pg.Pool,
  userId: string,
  thread: ThreadRow,
  question: string,
  answer: string,
): Promise<void> {
  await rememberExchange(pool, {
    userId,
    securityId: thread.context_type === 'security' ? thread.context_ref : null,
    content: `Q: ${question}\nA: ${answer}`,
    source: 'copilot',
    sourceRef: thread.id,
  });
}

export function registerCopilotRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // The threads list — the dedicated Copilot page is only history (§11.2).
  app.get('/v1/copilot/threads', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT id, title, context_type, context_ref, created_at, last_message_at
         FROM copilot_threads WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 100`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  app.get('/v1/copilot/threads/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const thread = await ownedThread(pool, user.id, id);
    if (!thread) return problem(reply, req, 404, 'not-found', 'Thread not found');
    const { rows: messages } = await pool.query(
      `SELECT id, role, content, model, degraded, generative, guard_approved, created_at
         FROM copilot_messages WHERE thread_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return reply.send({ data: { thread, messages } });
  });

  // Open a thread FROM a context (§11.2). The server loads the bound context and
  // primes the first assistant turn with it, so the conversation already knows
  // what the user is looking at.
  app.post('/v1/copilot/threads', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'context_type is required', parsed.error.issues[0]?.message);
    }
    const refInput: CopilotContextRef = { type: parsed.data.context_type, ref: parsed.data.context_ref ?? null };

    let context: CopilotContext;
    try {
      context = await buildCopilotContext(pool, user.id, user.baseCurrency, refInput);
    } catch (err) {
      if (err instanceof CopilotContextError) return problem(reply, req, 404, 'not-found', err.message);
      throw err;
    }

    const { rows: created } = await pool.query(
      `INSERT INTO copilot_threads (user_id, title, context_type, context_ref)
       VALUES ($1,$2,$3,$4) RETURNING id, title, context_type, context_ref, created_at, last_message_at`,
      [user.id, context.title, context.type, context.ref],
    );
    const thread = created[0] as ThreadRow;

    // The context-primed opener — "begin with contextual information already
    // loaded". No user message needed; the context is the subject.
    const opener = await answerCopilot(pool, {
      userId: user.id,
      baseCurrency: user.baseCurrency,
      context,
      history: [],
      userMessage: 'What am I looking at here?',
    });
    const msg = await insertMessage(pool, thread.id, user.id, 'assistant', opener.text, {
      model: opener.model,
      traceId: opener.traceId,
      degraded: opener.degraded,
      generative: opener.generative,
      guardApproved: opener.guardApproved,
    });

    return reply.status(201).send({
      data: {
        thread,
        messages: [
          {
            id: msg.id,
            role: 'assistant',
            content: opener.text,
            // Omitting these was P1-11: the SPA marks them optional, and its
            // `guard_approved === false` test is false for `undefined`, so a
            // guard-refused opener rendered as if Atlas had answered.
            degraded: opener.degraded,
            generative: opener.generative,
            guard_approved: opener.guardApproved,
            created_at: msg.created_at,
          },
        ],
      },
    });
  });

  // A non-streamed turn.
  app.post('/v1/copilot/threads/:id/messages', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const thread = await ownedThread(pool, user.id, id);
    if (!thread) return problem(reply, req, 404, 'not-found', 'Thread not found');
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return problem(reply, req, 400, 'validation', 'message is required');

    const context = await buildCopilotContext(pool, user.id, user.baseCurrency, {
      type: thread.context_type,
      ref: thread.context_ref,
    });
    const history = await loadHistory(pool, id);
    await insertMessage(pool, id, user.id, 'user', parsed.data.message);

    const answer = await answerCopilot(pool, {
      userId: user.id,
      baseCurrency: user.baseCurrency,
      context,
      history,
      userMessage: parsed.data.message,
    });
    const msg = await insertMessage(pool, id, user.id, 'assistant', answer.text, {
      model: answer.model,
      traceId: answer.traceId,
      degraded: answer.degraded,
      generative: answer.generative,
      guardApproved: answer.guardApproved,
    });
    if (answer.guardApproved) await rememberTurn(pool, user.id, thread, parsed.data.message, answer.text);

    return reply.send({
      data: {
        id: msg.id,
        role: 'assistant',
        content: answer.text,
        degraded: answer.degraded,
        generative: answer.generative,
        guard_approved: answer.guardApproved,
        created_at: msg.created_at,
      },
    });
  });

  // A streamed turn (SSE). The answer is generated AND guarded first, then
  // streamed — we never stream content that has not passed the Guard.
  app.post('/v1/copilot/threads/:id/stream', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const thread = await ownedThread(pool, user.id, id);
    if (!thread) return problem(reply, req, 404, 'not-found', 'Thread not found');
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return problem(reply, req, 400, 'validation', 'message is required');

    const context = await buildCopilotContext(pool, user.id, user.baseCurrency, {
      type: thread.context_type,
      ref: thread.context_ref,
    });
    const history = await loadHistory(pool, id);
    await insertMessage(pool, id, user.id, 'user', parsed.data.message);

    const answer = await answerCopilot(pool, {
      userId: user.id,
      baseCurrency: user.baseCurrency,
      context,
      history,
      userMessage: parsed.data.message,
    });
    const msg = await insertMessage(pool, id, user.id, 'assistant', answer.text, {
      model: answer.model,
      traceId: answer.traceId,
      degraded: answer.degraded,
      generative: answer.generative,
      guardApproved: answer.guardApproved,
    });
    if (answer.guardApproved) await rememberTurn(pool, user.id, thread, parsed.data.message, answer.text);

    /**
     * From here the reply is hijacked: Fastify's error handling no longer
     * applies, so anything thrown below is an unhandled exception in a process
     * with no uncaughtException handler. A user closing the tab mid-stream
     * makes the socket emit ECONNRESET/EPIPE, and writing to it throws — one
     * navigation away could take the API down for everyone.
     *
     * The turn is already persisted at this point, so a stream that dies costs
     * nothing: the answer is in the thread and the client reads it on reload.
     */
    reply.hijack();
    const raw = reply.raw;

    // A socket error must never reach the process. Once the peer is gone there
    // is nothing to say and nothing to clean up beyond stopping.
    let closed = false;
    const stop = () => {
      closed = true;
    };
    raw.on('error', (err) => {
      stop();
      req.log.info({ err, traceId: req.traceId }, 'copilot stream ended early');
    });
    raw.on('close', stop);

    /** Every write goes through here: after a close, writes are dropped. */
    const send = (event: string, data: unknown): boolean => {
      if (closed || raw.destroyed || raw.writableEnded) return false;
      try {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch (err) {
        stop();
        req.log.info({ err, traceId: req.traceId }, 'copilot stream write failed');
        return false;
      }
    };

    try {
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      // Stream the guarded text in word chunks — real SSE, honest content.
      const tokens = answer.text.match(/\S+\s*/g) ?? [answer.text];
      for (const t of tokens) {
        if (!send('delta', { delta: t })) break;
      }
      send('done', {
        id: msg.id,
        degraded: answer.degraded,
        generative: answer.generative,
        guard_approved: answer.guardApproved,
        created_at: msg.created_at,
      });
    } catch (err) {
      req.log.warn({ err, traceId: req.traceId }, 'copilot stream failed');
    } finally {
      if (!raw.destroyed && !raw.writableEnded) {
        try {
          raw.end();
        } catch {
          // The peer is already gone; there is nothing left to close.
        }
      }
    }
  });
}
