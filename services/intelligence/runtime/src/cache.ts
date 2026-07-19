/**
 * Shared-analysis cache (§40). Layer-1 (user-agnostic) agent output only.
 * The table has no user column; the runtime only calls these for requests with
 * a null user (§40.4 — personal contextualizations are never cached).
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { LlmToolCall } from './provider.js';

export type Db = pg.Pool | pg.PoolClient;

export function cacheKey(agent: string, promptVersion: string, inputHash: string): string {
  return createHash('sha256').update(`${agent}|${promptVersion}|${inputHash}`).digest('hex');
}

export interface CachedOutput {
  text: string;
  toolCalls: LlmToolCall[];
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function cacheGet(db: Db, key: string): Promise<CachedOutput | null> {
  const { rows } = await db.query(
    `SELECT model, output, input_tokens, output_tokens FROM shared_analysis_cache
      WHERE cache_key = $1 AND ttl_expires_at > now()`,
    [key],
  );
  if (rows.length === 0) return null;
  const out = rows[0].output as { text: string; toolCalls?: LlmToolCall[] };
  return {
    text: out.text,
    toolCalls: out.toolCalls ?? [],
    model: rows[0].model,
    inputTokens: rows[0].input_tokens,
    outputTokens: rows[0].output_tokens,
  };
}

export interface CachePutInput {
  key: string;
  agent: string;
  promptVersion: string;
  inputHash: string;
  model: string;
  text: string;
  toolCalls: LlmToolCall[];
  inputTokens: number;
  outputTokens: number;
  ttlSeconds: number;
}

export async function cachePut(db: Db, input: CachePutInput): Promise<void> {
  await db.query(
    `INSERT INTO shared_analysis_cache
       (cache_key, agent, prompt_version, input_hash, model, output,
        input_tokens, output_tokens, ttl_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' seconds')::interval)
     ON CONFLICT (cache_key) DO UPDATE SET
       model = EXCLUDED.model, output = EXCLUDED.output,
       input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
       created_at = now(), ttl_expires_at = EXCLUDED.ttl_expires_at`,
    [
      input.key,
      input.agent,
      input.promptVersion,
      input.inputHash,
      input.model,
      JSON.stringify({ text: input.text, toolCalls: input.toolCalls }),
      input.inputTokens,
      input.outputTokens,
      String(input.ttlSeconds),
    ],
  );
}

/** Invalidate every cached analysis for a security (event-driven, §40.3). */
export async function cacheInvalidateInputHashPrefix(db: Db, inputHashPrefix: string): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM shared_analysis_cache WHERE input_hash LIKE $1 || '%'`,
    [inputHashPrefix],
  );
  return rowCount ?? 0;
}
