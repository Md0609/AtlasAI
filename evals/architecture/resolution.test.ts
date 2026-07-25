/**
 * The test gate must grade the source it claims to grade (W0 / P0-2).
 *
 * Before this, every workspace resolved `@atlas/*` to `dist/`, so `npm test`
 * graded the previous build. Proven, not inferred: mutating
 * `signal-engine/src/concentration.ts` (`knownTotal.gt(0)` → `.gte(0)`) without
 * rebuilding left the suite at 49/49 passing. The Signal Engine is the module
 * this repo calls its release gate.
 *
 * These tests are the structural anchor for the fix. They deliberately do not
 * re-run a mutation — a test cannot usefully sabotage the tree it is running
 * in — they pin the two properties that make a mutation detectable at all:
 *
 *   1. imports of internal packages land on source, so no compiled artefact is
 *      left that could be stale;
 *   2. a module reached by two different specifiers is ONE module, so
 *      module-level state cannot silently fork.
 *
 * Remove the alias in vitest.config.ts and these fail immediately, rather than
 * the suite quietly going back to grading yesterday's build.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two specifiers for one module: the package name, and a relative path to its
// source. Under the alias these must be the same module instance. This is the
// real evidence of where `@atlas/*` resolved — stronger than inspecting config,
// because it observes what the runtime actually loaded.
import * as guardViaPackage from '@atlas/guard';
import * as guardViaSource from '../../services/intelligence/guard/src/index.js';
import * as engineViaPackage from '@atlas/signal-engine';
import * as engineViaSource from '../../services/signal-engine/src/index.js';

import { ATLAS_SOURCE_ALIASES } from '../../vitest.config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('one module, one instance', () => {
  it('gives the same function reference through the package name and through src/', () => {
    // Measured as `false` before the fix: `@atlas/guard` loaded dist while the
    // relative import loaded source, so `guardText !== guardText`.
    expect(guardViaPackage.guardText).toBe(guardViaSource.guardText);
    expect(guardViaPackage.lexicalScreen).toBe(guardViaSource.lexicalScreen);
    expect(engineViaPackage.xirr).toBe(engineViaSource.xirr);
  });

  it('shares module-level state across specifiers', () => {
    // Five modules hold module-level state — the provider override, the metrics
    // counters, the decoy password hash, the embedder cache. Two instances mean
    // a test configuring one while the code under test reads the other.
    expect(guardViaPackage.LEXICAL_RULES).toBe(guardViaSource.LEXICAL_RULES);
  });
});

describe('internal packages resolve to source, not to dist', () => {
  it('maps every @atlas specifier onto a .ts file under src/', () => {
    expect(ATLAS_SOURCE_ALIASES.length).toBeGreaterThan(10);
    for (const { specifier, source } of ATLAS_SOURCE_ALIASES) {
      expect(source, `${specifier} must resolve to source`).toMatch(/\/src\/[^/]*\.ts$/);
      expect(source, `${specifier} must not resolve into dist/`).not.toContain('/dist/');
    }
  });

  it('covers every workspace that builds to dist, derived rather than hardcoded', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      workspaces: string[];
    };
    const aliased = new Set(ATLAS_SOURCE_ALIASES.map((a) => a.specifier));

    for (const ws of root.workspaces) {
      const manifest = JSON.parse(readFileSync(resolve(ROOT, ws, 'package.json'), 'utf8')) as {
        name?: string;
        main?: string;
      };
      // apps/web is a Vite app with no library entry point; nothing imports it.
      if (!manifest.name?.startsWith('@atlas/') || !manifest.main?.startsWith('dist/')) continue;
      expect(aliased, `${manifest.name} builds to dist but has no source alias`).toContain(
        manifest.name,
      );
    }
  });

  it('resolves a subpath export to its own source file, not the package index', () => {
    // `@atlas/api` → src/server.ts and `@atlas/api/internal` → src/internal.ts.
    // Order is load-bearing: the subpath is emitted first so a bare rule cannot
    // swallow it. Both entries are anchored, so this is belt and braces.
    const internal = ATLAS_SOURCE_ALIASES.find((a) => a.specifier === '@atlas/api/internal');
    const bare = ATLAS_SOURCE_ALIASES.find((a) => a.specifier === '@atlas/api');
    expect(internal?.source).toMatch(/\/apps\/api\/src\/internal\.ts$/);
    expect(bare?.source).toMatch(/\/apps\/api\/src\/server\.ts$/);
    expect(ATLAS_SOURCE_ALIASES.indexOf(internal!)).toBeLessThan(
      ATLAS_SOURCE_ALIASES.indexOf(bare!),
    );
  });
});

describe('the gate builds before it runs', () => {
  it('npm test compiles first, because Vitest strips types without checking them', () => {
    // esbuild erases types rather than verifying them, so Vitest alone would
    // pass on code tsc rejects. The build step is what makes `npm test` a gate
    // on types, and what keeps dist/ — which production runs — current.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    const script = pkg.scripts.test ?? '';
    expect(script).toContain('tsc -b');
    expect(script.indexOf('tsc -b')).toBeLessThan(script.indexOf('vitest'));
  });
});
