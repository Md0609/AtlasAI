/**
 * Architecture tests (§47.2) — "the document's immune system."
 *
 * Each test makes a principle structural: every one of these can be undone
 * by one well-intentioned PR eighteen months from now, and this file is what
 * fails the build when it happens. Any PR touching this file deserves the
 * friction of a very deliberate review (§47.2).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string, exts = ['.ts', '.tsx']): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => p.endsWith(e))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => p.slice(ROOT.length + 1);

describe('§47.2 — values enforced by build failure', () => {
  it('the Guard is invoked ONLY by the egress module (non-bypassability, §21.6)', () => {
    const offenders: string[] = [];
    for (const dir of ['apps', 'services', 'packages', 'ops'].map((d) => join(ROOT, d))) {
      for (const file of sourceFiles(dir)) {
        if (!read(file).includes('@atlas/guard')) continue;
        const r = rel(file);
        const allowed =
          r.startsWith('services/intelligence/egress/') || r.startsWith('services/intelligence/guard/');
        if (!allowed) offenders.push(r);
      }
    }
    expect(offenders, 'only egress may import the guard — content must flow through the single constructor').toEqual([]);
  });

  it('UserFacingContent is constructed only inside the egress module (§A3.3)', () => {
    const offenders: string[] = [];
    for (const dir of ['apps', 'services', 'packages', 'ops'].map((d) => join(ROOT, d))) {
      for (const file of sourceFiles(dir)) {
        if (!/new\s+UserFacingContent/.test(read(file))) continue;
        const r = rel(file);
        if (!r.startsWith('services/intelligence/egress/src/')) offenders.push(r);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Signal Engine is pure: no database, no user concept (§21.2 layer boundary)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'services/signal-engine/src'))) {
      const src = read(file);
      if (/from\s+'pg'|require\('pg'\)/.test(src)) offenders.push(`${rel(file)}: imports pg`);
      if (/\buser_?id\b/i.test(src)) offenders.push(`${rel(file)}: mentions a user`);
    }
    expect(offenders, 'the engine computes over portfolios; users exist above it').toEqual([]);
  });

  it('no float on money: migrations never use floating-point column types (§27.3)', () => {
    const offenders: string[] = [];
    const migrations = join(ROOT, 'packages/schema/migrations');
    for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql'))) {
      const sql = read(join(migrations, f));
      if (/\b(double precision|float4|float8)\b/i.test(sql)) offenders.push(f);
      // 'real' as a column type: match "colname real," / "real)" forms only.
      if (/^\s*\w+\s+real\s*[,)]/im.test(sql)) offenders.push(`${f} (real)`);
    }
    expect(offenders).toEqual([]);
  });

  it('append-only triggers exist for every ledger the product\'s promises rest on', () => {
    const migrations = join(ROOT, 'packages/schema/migrations');
    const all = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => read(join(migrations, f)))
      .join('\n');
    for (const table of ['audit_log', 'events', 'decisions', 'guard_decisions']) {
      const pattern = new RegExp(`(UPDATE OR DELETE ON ${table}|ON ${table}\\b[\\s\\S]{0,80}forbid_mutation)`, 'i');
      expect(
        pattern.test(all) || new RegExp(`TRIGGER \\w+ BEFORE UPDATE OR DELETE ON ${table}`, 'i').test(all),
        `append-only trigger missing for ${table}`,
      ).toBe(true);
    }
    // Immutability triggers for versioned user content:
    expect(/theses_immutable/.test(all)).toBe(true);
    expect(/profile_versions_immutable/.test(all)).toBe(true);
  });

  it('the API delivery layer never renders intelligence prose that skipped egress', () => {
    // At 4a no LLM output exists; the enforceable invariant today: nothing in
    // apps/ constructs Contextualization rendering by hand — apps may only
    // receive UserFacingContent from @atlas/egress.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'apps'))) {
      const src = read(file);
      if (/ContextualizationDoc/.test(src) && !/@atlas\/egress/.test(src)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders, 'apps touching ContextualizationDoc must go through @atlas/egress').toEqual([]);
  });
});
