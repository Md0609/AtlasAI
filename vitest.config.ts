import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
