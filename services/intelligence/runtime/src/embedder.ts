/**
 * The embedding boundary (§30.3, D-013). Like the LLM provider, the embedding
 * model is a swappable dependency behind an interface; the business layer only
 * ever sees `number[]`.
 *
 * The default is a DETERMINISTIC mock (§B8 "mock first, replace later"): a
 * hashing bag-of-words vectorizer with no network, byte-identical for the same
 * text, whose cosine similarity reflects lexical overlap. That is enough for
 * development and tests, and the real embedding model is a drop-in behind this
 * interface (ATLAS_EMBED_PROVIDER) — no caller changes.
 */
import { createHash } from 'node:crypto';

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

export class HashEmbedder implements Embedder {
  readonly model = 'hash-mock-v1';
  readonly dim = 256;

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const t of tokens) {
      const h = parseInt(createHash('sha1').update(t).digest('hex').slice(0, 8), 16);
      const idx = h % this.dim;
      v[idx] = (v[idx] ?? 0) + ((h >> 8) % 2 === 0 ? 1 : -1); // signed hashing reduces collisions
    }
    // L2-normalise so cosine similarity is a plain dot product.
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

let cached: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (cached) return cached;
  // ATLAS_EMBED_PROVIDER selects the model; the deterministic mock is default.
  cached = new HashEmbedder();
  return cached;
}

/** Tests inject an embedder directly. */
export function setEmbedderForTests(e: Embedder | null): void {
  cached = e;
}

/** Cosine similarity of two L2-normalised vectors (= dot product). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
