/**
 * Observability: structured logs and the handful of counters worth watching.
 *
 * The server ran with `logger: false`. Nothing was recorded — no request line,
 * no latency, no error beyond a bare console.error, and the trace_id that
 * every problem+json response hands the user (§31.5) pointed at nothing on our
 * side. A user could quote a trace_id and we had no way to look it up.
 *
 * Fastify already bundles pino, so this adds structure rather than a
 * dependency.
 *
 * Two rules the redaction below exists to keep:
 *
 *  - Logs are not an exemption from §35. An email in a log line is personal
 *    data in a system with a different retention policy and a different access
 *    control list than the database it came from, and it survives account
 *    erasure. Credentials, cookies and tokens must never appear at all.
 *  - Counters are aggregate only. Nothing here is per-user; the audit log is
 *    where per-user history belongs, and it is already immutable.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { queueStats } from '@atlas/bus';

/**
 * `stream` exists so the test suite can assert on what is actually written —
 * redaction that is never read back is a claim, not a control. When it is
 * supplied it wins over ATLAS_LOG, which is how the suite stays quiet by
 * default while the observability test still opts in.
 */
export function loggerOptions(stream?: NodeJS.WritableStream): object | boolean {
  if (!stream && process.env.ATLAS_LOG === 'off') return false;
  return {
    ...(stream ? { stream } : {}),
    level: process.env.ATLAS_LOG_LEVEL ?? 'info',
    // pino's redaction runs on the serialised object, so it covers anything
    // that reaches a log line through the request/response serialisers.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'password',
        '*.password',
        'token',
        '*.token',
      ],
      censor: '[redacted]',
    },
    serializers: {
      // Deliberately minimal. No headers, no body, no query string: query
      // strings on this API carry portfolio ids, and a URL is the single most
      // common place personal data leaks into a log aggregator.
      req(req: FastifyRequest) {
        return {
          method: req.method,
          path: req.routeOptions?.url ?? req.url.split('?')[0],
          traceId: req.traceId,
        };
      },
      res(res: FastifyReply) {
        return { statusCode: res.statusCode };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Counters. In-process and non-persistent: this is a health signal, not
// analytics, and a restart resetting them is fine because the scrape interval
// is shorter than the deploy interval.
// ---------------------------------------------------------------------------

const counters = new Map<string, number>();

export function count(name: string, labels: Record<string, string> = {}, by = 1): void {
  const key = Object.keys(labels).length
    ? `${name}{${Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')}}`
    : name;
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}

/** Test-only: counters are process-global, so a suite needs to reset them. */
export function resetCounters(): void {
  counters.clear();
}

/** Prometheus text exposition. No client library — the format is six lines. */
function renderPrometheus(): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of [...counters].sort(([a], [b]) => a.localeCompare(b))) {
    const name = key.split('{')[0]!;
    if (!seen.has(name)) {
      lines.push(`# TYPE ${name} counter`);
      seen.add(name);
    }
    lines.push(`${key} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function registerObservability(app: FastifyInstance, pool: pg.Pool): void {
  // Request/response counters. Status CLASS, not status: a counter per exact
  // status code is a cardinality trap and answers no question worth asking.
  app.addHook('onResponse', async (req, reply) => {
    count('atlas_http_requests_total', {
      method: req.method,
      status: `${Math.floor(reply.statusCode / 100)}xx`,
    });
  });

  /**
   * Scrape endpoint, gated by a shared secret. Volumetry is competitively
   * sensitive and leaks user counts, so this is off unless a token is set
   * rather than open-by-default with a note in the runbook.
   */
  app.get('/metrics', async (req, reply) => {
    const expected = process.env.ATLAS_METRICS_TOKEN;
    if (!expected) return reply.status(404).send();
    const auth = req.headers.authorization ?? '';
    const want = `Bearer ${expected}`;
    // Constant-time: a scrape token is a credential like any other, and this
    // file sits next to a fix for exactly this class of bug.
    const a = Buffer.from(auth);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.status(401).send();
    // Queue depth is read from the database rather than kept as a counter:
    // a stuck partition is exactly the condition an in-memory counter would
    // lose on the restart that caused it.
    const q = await queueStats(pool);
    const gauges =
      `# TYPE atlas_job_queue_depth gauge\n` +
      `atlas_job_queue_depth{status="pending"} ${q.pending}\n` +
      `atlas_job_queue_depth{status="processing"} ${q.processing}\n` +
      `atlas_job_queue_depth{status="dead"} ${q.dead}\n`;
    return reply
      .header('content-type', 'text/plain; version=0.0.4')
      .send(renderPrometheus() + gauges);
  });
}
