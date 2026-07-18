/**
 * ingest CLI — `run` performs a full deterministic ingest from the configured
 * vendor (mock at Phase 1, per Design §B8) and prints the quality report.
 * The JSON report lands in ops/reports/ for the ops dashboard v0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '@atlas/schema';
import { routeEvents } from '@atlas/bus';
import { MockVendorAdapter, SNAPSHOT_FROM, SNAPSHOT_TO } from './mock-vendor.js';
import { CollectingEventSink, IngestPipeline } from './pipeline.js';
import { runQualityChecks } from './quality.js';

const cmd = process.argv[2];
if (cmd !== 'run') {
  console.error('Usage: node cli.js run   (uses ATLAS_DATABASE_URL)');
  process.exit(1);
}

const pool = createPool();
const sink = new CollectingEventSink();
const adapter = new MockVendorAdapter();

try {
  const pipeline = new IngestPipeline(pool, adapter, sink);
  console.log(`ingest: source=${adapter.source} window=${SNAPSHOT_FROM}..${SNAPSHOT_TO}`);
  const stats = await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  console.log(
    `securities: ${stats.securitiesCreated} created, ${stats.securitiesResolved} resolved | ` +
      `bars: ${stats.barsUpserted} | fx: ${stats.fxUpserted} | ` +
      `corporate actions: ${stats.corporateActions} | fundamentals: ${stats.fundamentals} | ` +
      `fund holdings: ${stats.fundHoldings}`,
  );
  console.log(
    `events emitted: ${sink.events.length} ` +
      `(${['market.price.eod', 'corporate.action', 'fund.holdings.updated']
        .map((t) => `${t}=${sink.events.filter((e) => e.type === t).length}`)
        .join(', ')})`,
  );

  // Phase 3: record events in the log and enqueue derived work (§24.2).
  // Run `npm run workers` afterwards to drain the queue.
  const { jobsEnqueued } = await routeEvents(pool, sink.events);
  console.log(`event log: ${sink.events.length} recorded, ${jobsEnqueued} security.changed job(s) enqueued`);

  const report = await runQualityChecks(pool, SNAPSHOT_FROM, SNAPSHOT_TO, stats.resolutionFindings);
  const reportsDir = process.env.ATLAS_REPORTS_DIR ?? join(process.cwd(), 'ops', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const file = join(reportsDir, 'quality-latest.json');
  writeFileSync(file, JSON.stringify(report, null, 2));

  console.log(`\nquality: universe=${report.universeSize} bars=${report.barsIngested}`);
  for (const f of report.findings.filter((f) => f.severity !== 'info')) {
    console.log(`  [${f.severity}] ${f.kind}: ${f.message}`);
  }
  console.log(`report written: ${file}`);
} finally {
  await pool.end();
}
