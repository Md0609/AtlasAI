/**
 * Memory — hybrid retrieval + injection (F-30, §30, FR-10).
 *
 * §30.3 retrieval is STRUCTURED-FIRST and structured-PINNED (D-013): the things
 * where being wrong is unforgivable — a user's rules, theses and decisions — are
 * a deterministic `SELECT ... WHERE user_id = $1`, never a cosine similarity,
 * and are never evicted under the token budget. The evictable layer is the
 * SEMANTIC one: free-text episodic memory (material Copilot exchanges, notes),
 * embedded and retrieved by similarity, reranked by recency.
 *
 * The vector store is behind the runtime's Embedder + a plain float-array
 * column (migration 018): correct over a single user's bounded item set, and
 * tenant-isolated by construction (every query is scoped to the user, FR-10.6).
 * pgvector + HNSW is the documented production swap (§30.3 / §41.6).
 */
import { cosine, getEmbedder } from '@atlas/runtime';
import type { Db } from '@atlas/dataplane';

export interface MemoryItem {
  id: string;
  kind: string;
  securityId: string | null;
  content: string;
  source: string;
  sourceRef: string | null;
  occurredAt: string;
  similarity?: number;
}

export interface StructuredFact {
  kind: 'rule' | 'thesis' | 'decision';
  text: string;
}

export interface MemoryBundle {
  /** Pinned — never evicted (§30.3 / D-013). */
  structured: StructuredFact[];
  /** Evictable — filled until the token budget is spent. */
  semantic: MemoryItem[];
  /** Rendered block for injection into agent context. */
  text: string;
  tokensUsed: number;
}

const DEFAULT_TOKEN_BUDGET = 1200;
const estTokens = (s: string): number => Math.ceil(s.length / 4);

export interface RememberInput {
  userId: string;
  content: string;
  securityId?: string | null;
  kind?: string;
  source?: 'copilot' | 'user' | 'system';
  sourceRef?: string | null;
}

/** Persist an episodic memory item and its embedding (FR-10.1). */
export async function rememberExchange(db: Db, input: RememberInput): Promise<string> {
  const embedder = getEmbedder();
  const vec = await embedder.embed(input.content);
  const { rows } = await db.query(
    `INSERT INTO memory_items (user_id, kind, security_id, content, source, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.userId,
      input.kind ?? 'copilot_exchange',
      input.securityId ?? null,
      input.content,
      input.source ?? 'copilot',
      input.sourceRef ?? null,
    ],
  );
  const id = rows[0].id as string;
  await db.query(
    `INSERT INTO memory_embeddings (memory_item_id, model, dim, embedding) VALUES ($1,$2,$3,$4)`,
    [id, embedder.model, embedder.dim, vec],
  );
  return id;
}

export interface RetrieveInput {
  userId: string;
  query: string;
  securityId?: string | null;
  tokenBudget?: number;
}

export async function retrieveMemory(db: Db, input: RetrieveInput): Promise<MemoryBundle> {
  const embedder = getEmbedder();
  const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  // 1. Structured — ALWAYS, from the live tables (the moat; §30.2/§30.3). Pinned.
  const structured: StructuredFact[] = [];
  const rules = await db.query(
    `SELECT r.rule_type, r.stated_reason,
            (SELECT e.status FROM rule_evaluations e WHERE e.rule_id = r.id
              ORDER BY e.evaluated_at DESC LIMIT 1) AS status
       FROM rules r WHERE r.user_id = $1 AND r.removed_at IS NULL`,
    [input.userId],
  );
  for (const r of rules.rows) {
    structured.push({ kind: 'rule', text: `Rule ${r.rule_type}${r.status ? ` (${r.status})` : ''}: "${r.stated_reason}"` });
  }
  const secArgs = input.securityId ? [input.userId, input.securityId] : [input.userId];
  const theses = await db.query(
    `SELECT statement FROM theses WHERE user_id = $1 AND status = 'active'
      ${input.securityId ? 'AND security_id = $2' : ''}`,
    secArgs,
  );
  for (const t of theses.rows) structured.push({ kind: 'thesis', text: `Thesis: "${t.statement}"` });
  const decisions = await db.query(
    `SELECT action, reason_free_text FROM decisions WHERE user_id = $1
      ${input.securityId ? 'AND security_id = $2' : ''} ORDER BY decided_at DESC LIMIT 5`,
    secArgs,
  );
  for (const d of decisions.rows) {
    structured.push({ kind: 'decision', text: `Decision (${d.action}): "${d.reason_free_text}"` });
  }

  // 2. Semantic — cosine over the user's OWN items (tenant-isolated), reranked
  //    recency × relevance (§30.3). The last-7-days temporal band is subsumed by
  //    the recency term surfacing recent items.
  const qvec = await embedder.embed(input.query);
  const { rows: items } = await db.query(
    `SELECT mi.id, mi.kind, mi.security_id, mi.content, mi.source, mi.source_ref, mi.occurred_at, me.embedding
       FROM memory_items mi JOIN memory_embeddings me ON me.memory_item_id = mi.id
      WHERE mi.user_id = $1`,
    [input.userId],
  );
  const now = Date.now();
  const scored = items
    .map((r) => {
      const embedding = (r.embedding as unknown[]).map(Number);
      const sim = cosine(qvec, embedding);
      const ageDays = (now - new Date(r.occurred_at).getTime()) / 86_400_000;
      const recency = 1 / (1 + ageDays / 30);
      return { r, sim, score: sim * 0.7 + recency * 0.3 };
    })
    .sort((a, b) => b.score - a.score);

  // 3. Token budget — structured is pinned; semantic is evicted first (D-013).
  const structuredTokens = estTokens(structured.map((s) => s.text).join('\n'));
  let used = structuredTokens;
  const semantic: MemoryItem[] = [];
  for (const s of scored) {
    const item: MemoryItem = {
      id: s.r.id,
      kind: s.r.kind,
      securityId: s.r.security_id,
      content: s.r.content,
      source: s.r.source,
      sourceRef: s.r.source_ref,
      occurredAt: s.r.occurred_at,
      similarity: s.sim,
    };
    const t = estTokens(item.content);
    if (used + t > budget) break;
    semantic.push(item);
    used += t;
  }

  return { structured, semantic, text: renderBundle(structured, semantic), tokensUsed: used };
}

function renderBundle(structured: StructuredFact[], semantic: MemoryItem[]): string {
  const parts: string[] = [];
  if (structured.length > 0) {
    parts.push(
      'What Atlas knows about you (your own rules, theses and decisions — always in view):\n' +
        structured.map((s) => `- ${s.text}`).join('\n'),
    );
  }
  if (semantic.length > 0) {
    parts.push(
      'From your past conversations with Atlas:\n' +
        semantic.map((m) => `- "${m.content}" (${String(m.occurredAt).slice(0, 10)})`).join('\n'),
    );
  }
  return parts.join('\n\n');
}
