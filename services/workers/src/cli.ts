/**
 * workers CLI — `drain` processes the queue until quiet (run-once mode for
 * cron/dev); `watch` polls forever with a short sleep. No daemon framework:
 * a loop over a deterministic tick is auditable and boring (§25).
 */
import { createPool } from '@atlas/schema';
import { queueStats } from '@atlas/bus';
import { buildRunner } from './index.js';

const cmd = process.argv[2];
if (cmd !== 'drain' && cmd !== 'watch') {
  console.error('Usage: node cli.js drain|watch   (uses ATLAS_DATABASE_URL)');
  process.exit(1);
}

const pool = createPool();
const runner = buildRunner(pool);

try {
  if (cmd === 'drain') {
    const { processed, stats } = await runner.drain();
    console.log(`workers: processed=${processed} pending=${stats.pending} dead=${stats.dead}`);
  } else {
    console.log('workers: watching (Ctrl-C to stop)');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const n = await runner.tick();
      if (n === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
} finally {
  if (cmd === 'drain') {
    const stats = await queueStats(pool);
    if (stats.dead > 0) console.error(`workers: ${stats.dead} dead-lettered job(s) need attention`);
    await pool.end();
  }
}
