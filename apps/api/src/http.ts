/**
 * RFC 9457 problem+json with trace_id (§31.5). Every error response maps to
 * a trace; the trace_id is also stamped on audit rows for the same request.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export function problem(
  reply: FastifyReply,
  req: FastifyRequest,
  status: number,
  slug: string,
  title: string,
  detail?: string,
): FastifyReply {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json')
    .send({
      type: `https://atlas.ai/errors/${slug}`,
      title,
      status,
      ...(detail ? { detail } : {}),
      trace_id: (req as FastifyRequest & { traceId?: string }).traceId ?? 'unknown',
    });
}

// ---------------------------------------------------------------------------
// Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). No dependency:
// import mapping is Phase-1 core and must stay auditable.
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    // ignore fully-empty trailing lines
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      push();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      push();
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    push();
    pushRow();
  }
  return rows;
}
