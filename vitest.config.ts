import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve every `@atlas/*` import to TypeScript SOURCE instead of `dist/`.
 *
 * Every workspace declares `"main": "dist/index.js"`, so `import { xirr } from
 * '@atlas/signal-engine'` loaded compiled output. Two consequences, both bad:
 *
 *  1. `npm test` graded the previous build. A mutation to
 *     `signal-engine/src/concentration.ts` left 49/49 green, because nothing
 *     under test had been rebuilt — and the Signal Engine is the module this
 *     repo calls its release gate.
 *  2. Resolution was MIXED, sometimes within one file. `golden.test.ts` imports
 *     `@atlas/signal-engine` (dist) while `radar.test.ts` imports `../src/`
 *     (source), so one module could be loaded twice under two identities.
 *     Verified: importing `@atlas/guard` and `guard/src/index.ts` in the same
 *     test yields `guardText !== guardText`. Five modules hold module-level
 *     state — `factory.ts`'s provider override, `observability.ts`'s counters,
 *     `auth.ts`'s decoy hash, `embedder.ts`'s cache — and would each get two
 *     independent copies.
 *
 * Aliasing to source fixes both: no compiled artefact remains to go stale, and
 * one specifier means one instance.
 *
 * The alias is DERIVED from each workspace's own entry point rather than
 * hardcoded, so a new package is covered as soon as it exists, and a package
 * whose entry is not `index` (`@atlas/api` → `src/server.ts`) needs no special
 * case.
 *
 * This does not make `dist/` irrelevant — production runs it. `npm test` still
 * runs `tsc -b` first, which is what proves source compiles and keeps `dist/`
 * current; esbuild strips types without checking them, so Vitest alone would
 * never catch a type error.
 */
export interface AtlasAlias {
  /** The bare specifier, e.g. `@atlas/api` or `@atlas/api/internal`. */
  specifier: string;
  /** Absolute path to the TypeScript source it resolves to. */
  source: string;
}

function atlasSourceAliases(): AtlasAlias[] {
  const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    workspaces: string[];
  };
  const aliases: AtlasAlias[] = [];

  /** `dist/server.js` → `src/server.ts`. Null for anything not built to dist. */
  const toSource = (entry: string | undefined): string | null => {
    if (!entry) return null;
    if (!entry.startsWith('dist/') && !entry.startsWith('./dist/')) return null;
    return entry.replace(/^\.?\/?dist\//, 'src/').replace(/\.js$/, '.ts');
  };

  for (const ws of root.workspaces) {
    let manifest: {
      name?: string;
      main?: string;
      exports?: Record<string, { default?: string } | string>;
    };
    try {
      manifest = JSON.parse(readFileSync(resolve(ROOT, ws, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const name = manifest.name;
    if (!name?.startsWith('@atlas/')) continue;

    // Subpaths first: a bare `@atlas/api` rule would otherwise match
    // `@atlas/api/internal` before the subpath's own rule is reached.
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (subpath === '.') continue;
      const src = toSource(typeof target === 'string' ? target : target.default);
      if (!src) continue;
      aliases.push({
        specifier: `${name}${subpath.replace(/^\./, '')}`,
        source: resolve(ROOT, ws, src),
      });
    }

    const rootExport = manifest.exports?.['.'];
    const mainEntry =
      (typeof rootExport === 'string' ? rootExport : rootExport?.default) ?? manifest.main;
    const src = toSource(mainEntry);
    if (!src) continue; // apps/web has no library entry point; nothing imports it.
    aliases.push({ specifier: name, source: resolve(ROOT, ws, src) });
  }

  return aliases;
}

/**
 * Exported so the resolution test can assert on the mapping itself rather than
 * re-deriving it — a test that recomputes the thing it checks proves nothing.
 * Order is load-bearing: subpaths precede their bare package.
 */
export const ATLAS_SOURCE_ALIASES: AtlasAlias[] = atlasSourceAliases();

export default defineConfig({
  resolve: {
    alias: ATLAS_SOURCE_ALIASES.map((a) => ({
      // Anchored so `@atlas/api` cannot match `@atlas/api/internal`; the
      // subpath entry is emitted first and wins on its own exact rule.
      find: new RegExp(`^${a.specifier.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}$`),
      replacement: a.source,
    })),
  },
  test: {
    environment: 'node',
    // Quiet by default: the suite is not a log-reading exercise. The
    // observability test opts back in by passing buildServer its own stream.
    env: { ATLAS_LOG: 'off' },
    // Integration suites share one Postgres database — run files sequentially.
    fileParallelism: false,
    include: [
      'packages/**/test/**/*.test.ts',
      'services/signal-engine/golden/**/*.test.ts',
      'services/ingest/test/**/*.test.ts',
      'services/workers/test/**/*.test.ts',
      'services/intelligence/*/test/**/*.test.ts',
      'apps/api/test/**/*.test.ts',
      'evals/**/*.test.ts',
      // apps/web had no glob at all, so a frontend test could not have run even
      // if one had been written. Tests themselves are a later wave; the door is
      // open so that wave does not also have to fix the config.
      'apps/web/test/**/*.test.{ts,tsx}',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
