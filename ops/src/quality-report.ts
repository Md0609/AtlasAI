/**
 * Quality dashboard v0 (Design §B1 Phase 1): renders the latest ingest
 * quality report from ops/reports/quality-latest.json as a terminal table.
 * A web dashboard replaces this in a later phase; the report contract
 * (@atlas/contracts QualityReport) stays the same.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QualityReport } from '@atlas/contracts';

const file =
  process.argv[2] ?? join(process.cwd(), 'ops', 'reports', 'quality-latest.json');

let report: QualityReport;
try {
  report = JSON.parse(readFileSync(file, 'utf8')) as QualityReport;
} catch {
  console.error(`No quality report at ${file} — run \`npm run ingest\` first.`);
  process.exit(1);
}

console.log(`Atlas data-quality report  (generated ${report.generatedAt})`);
console.log(`universe: ${report.universeSize} securities · bars in window: ${report.barsIngested}\n`);

const kinds = Object.keys(report.summary) as Array<keyof QualityReport['summary']>;
console.log('check                 warn  error');
console.log('--------------------  ----  -----');
for (const k of kinds) {
  const s = report.summary[k];
  console.log(`${k.padEnd(20)}  ${String(s.warn).padStart(4)}  ${String(s.error).padStart(5)}`);
}

const visible = report.findings.filter((f) => f.severity !== 'info');
if (visible.length > 0) {
  console.log('\nfindings:');
  for (const f of visible) {
    console.log(`  [${f.severity.toUpperCase().padEnd(5)}] ${f.kind}: ${f.message}`);
  }
}
const infos = report.findings.filter((f) => f.severity === 'info');
if (infos.length > 0) {
  console.log('\ninfo:');
  for (const f of infos) console.log(`  ${f.message}`);
}
