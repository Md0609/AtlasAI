// vitest.config.ts
import { defineConfig } from "file:///sessions/serene-stoic-mayer/mnt/atlas-ai/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  test: {
    environment: "node",
    // Quiet by default: the suite is not a log-reading exercise. The
    // observability test opts back in by passing buildServer its own stream.
    env: { ATLAS_LOG: "off" },
    // Integration suites share one Postgres database — run files sequentially.
    fileParallelism: false,
    include: [
      "packages/**/test/**/*.test.ts",
      "services/signal-engine/golden/**/*.test.ts",
      "services/ingest/test/**/*.test.ts",
      "services/workers/test/**/*.test.ts",
      "services/intelligence/*/test/**/*.test.ts",
      "apps/api/test/**/*.test.ts",
      "evals/**/*.test.ts"
    ],
    testTimeout: 12e4,
    hookTimeout: 12e4
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy9zZXJlbmUtc3RvaWMtbWF5ZXIvbW50L2F0bGFzLWFpXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvc2Vzc2lvbnMvc2VyZW5lLXN0b2ljLW1heWVyL21udC9hdGxhcy1haS92aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy9zZXJlbmUtc3RvaWMtbWF5ZXIvbW50L2F0bGFzLWFpL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgdGVzdDoge1xuICAgIGVudmlyb25tZW50OiAnbm9kZScsXG4gICAgLy8gUXVpZXQgYnkgZGVmYXVsdDogdGhlIHN1aXRlIGlzIG5vdCBhIGxvZy1yZWFkaW5nIGV4ZXJjaXNlLiBUaGVcbiAgICAvLyBvYnNlcnZhYmlsaXR5IHRlc3Qgb3B0cyBiYWNrIGluIGJ5IHBhc3NpbmcgYnVpbGRTZXJ2ZXIgaXRzIG93biBzdHJlYW0uXG4gICAgZW52OiB7IEFUTEFTX0xPRzogJ29mZicgfSxcbiAgICAvLyBJbnRlZ3JhdGlvbiBzdWl0ZXMgc2hhcmUgb25lIFBvc3RncmVzIGRhdGFiYXNlIFx1MjAxNCBydW4gZmlsZXMgc2VxdWVudGlhbGx5LlxuICAgIGZpbGVQYXJhbGxlbGlzbTogZmFsc2UsXG4gICAgaW5jbHVkZTogW1xuICAgICAgJ3BhY2thZ2VzLyoqL3Rlc3QvKiovKi50ZXN0LnRzJyxcbiAgICAgICdzZXJ2aWNlcy9zaWduYWwtZW5naW5lL2dvbGRlbi8qKi8qLnRlc3QudHMnLFxuICAgICAgJ3NlcnZpY2VzL2luZ2VzdC90ZXN0LyoqLyoudGVzdC50cycsXG4gICAgICAnc2VydmljZXMvd29ya2Vycy90ZXN0LyoqLyoudGVzdC50cycsXG4gICAgICAnc2VydmljZXMvaW50ZWxsaWdlbmNlLyovdGVzdC8qKi8qLnRlc3QudHMnLFxuICAgICAgJ2FwcHMvYXBpL3Rlc3QvKiovKi50ZXN0LnRzJyxcbiAgICAgICdldmFscy8qKi8qLnRlc3QudHMnLFxuICAgIF0sXG4gICAgdGVzdFRpbWVvdXQ6IDEyMF8wMDAsXG4gICAgaG9va1RpbWVvdXQ6IDEyMF8wMDAsXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBaVQsU0FBUyxvQkFBb0I7QUFFOVUsSUFBTyx3QkFBUSxhQUFhO0FBQUEsRUFDMUIsTUFBTTtBQUFBLElBQ0osYUFBYTtBQUFBO0FBQUE7QUFBQSxJQUdiLEtBQUssRUFBRSxXQUFXLE1BQU07QUFBQTtBQUFBLElBRXhCLGlCQUFpQjtBQUFBLElBQ2pCLFNBQVM7QUFBQSxNQUNQO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsYUFBYTtBQUFBLElBQ2IsYUFBYTtBQUFBLEVBQ2Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
