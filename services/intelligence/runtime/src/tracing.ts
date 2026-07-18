/**
 * Agent tracing (Phase 4a, §23.4/§42.1): every model call is a span with
 * prompt version, model, tokens, cost and cache status — recorded before the
 * first agent exists, because "provenance is not a feature you add; it's a
 * property of the data path" (§21.5). Append-only, 7-year retention (§36).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

export interface AgentMessage {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  userId: string | null; // null for shared Layer-1 work (§21.2)
  agent: string;
  promptVersion: string;
  promptHash: string;
  model: string;
  modelVersion?: string;
  inputHash: string;
  output: unknown;
  gaps?: Array<{ component: string; reason: string }>;
  inputTokens?: number;
  outputTokens?: number;
  costEur?: string; // decimal string (§27.3.2)
  latencyMs?: number;
  cacheHit?: boolean;
}

export function newTraceId(): string {
  return randomUUID();
}

export async function recordAgentMessage(db: Db, msg: AgentMessage): Promise<string> {
  await db.query(`SELECT ensure_agent_messages_partition(now())`);
  const spanId = msg.spanId ?? randomUUID();
  await db.query(
    `INSERT INTO agent_messages
       (trace_id, span_id, parent_span_id, user_id, agent, prompt_version, prompt_hash,
        model, model_version, input_hash, output, gaps, input_tokens, output_tokens,
        cost_eur, latency_ms, cache_hit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      msg.traceId,
      spanId,
      msg.parentSpanId ?? null,
      msg.userId,
      msg.agent,
      msg.promptVersion,
      msg.promptHash,
      msg.model,
      msg.modelVersion ?? '',
      msg.inputHash,
      JSON.stringify(msg.output ?? {}),
      JSON.stringify(msg.gaps ?? []),
      msg.inputTokens ?? 0,
      msg.outputTokens ?? 0,
      msg.costEur ?? '0',
      msg.latencyMs ?? 0,
      msg.cacheHit ?? false,
    ],
  );
  return spanId;
}
