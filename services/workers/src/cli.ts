/**
 * workers CLI — `drain` processes the queue until quiet (run-once mode for
 * cron/dev); `watch` polls forever with a short sleep. No daemon framework:
 * a loop over a deterministic tick is auditable and boring (§25).
 *
 * `watch` is the mode a deployment runs. Before this it was an unbreakable
 * `while (true)` with no signal handling: SIGTERM killed it mid-job, and the
 * `finally` that closes the pool was unreachable because the loop never exits.
 * Losing a job mid-flight is survivable — the lease expires and another worker
 * reclaims it (migration 020) — but it costs a delay and an attempt for nothing,
 * and it leaves the pool open until the process is killed outright.
 *
 * The loop now stops BETWEEN ticks, so a shutdown finishes the job in hand.
 */
import { createPool, migrate, pendingMigrations } from '@atlas/schema';
import { queueStats } from '@atlas/bus';
import { boolEnv, intEnv } from '@atlas/config';
import { StopSignal, installLifecycle } from '@atlas/lifecycle';
import { buildRunner, scheduleWeeklyReviews } from './index.js';

const cmd = process.argv[2];
if (cmd !== 'drain' && cmd !== 'watch') {
  console.error('Usage: node cli.js drain|watch   (uses ATLAS_DATABASE_URL)');
  process.exit(1);
}

const pool = createPool();

/**
 * The worker reads the same schema as the API, so it carries the same
 * requirement (N-4). It does NOT apply migrations by default: two components
 * racing to migrate is a worse default than one doing it, and the API already
 * does. The advisory lock makes it safe if a deployment prefers it here.
 */
if (boolEnv('ATLAS_MIGRATE_ON_START', { fallback: false })) {
  await migrate(pool);
} else {
  const pending = await pendingMigrations(pool);
  if (pending.length > 0) {
    console.error(
      `workers: refusing to start — ${pending.length} unapplied migration(s): ${pending.join(', ')}`,
    );
    await pool.end();
    process.exit(1);
  }
}

const runner = buildRunner(pool);
const stop = new StopSignal();

installLifecycle({
  tasks: [
    // Ask the loop to finish its current tick; the pool closes once it has.
    { name: 'worker-loop', run: async () => stop.request() },
    { name: 'database', run: () => pool.end() },
  ],
});

if (cmd === 'drain') {
  const { processed, stats } = await runner.drain();
  console.log(`workers: processed=${processed} pending=${stats.pending} dead=${stats.dead}`);
  const final = await queueStats(pool);
  if (final.dead > 0) console.error(`workers: ${final.dead} dead-lettered job(s) need attention`);
  await pool.end();
} else {
  console.log('workers: watching (SIGTERM or Ctrl-C to stop)');

  /**
   * Due-work sweep (P0-5).
   *
   * scheduleWeeklyReviews existed and was called from NOTHING but tests, so no
   * user would ever have received a Weekly Review. It is due-based and
   * idempotent — it skips users who already have this week's review or a job in
   * flight — which is what makes it safe to call on a plain interval and safe
   * to run in several worker processes at once.
   *
   * Deliberately in-process rather than an external cron: it needs no
   * infrastructure decision, it stops when the worker stops, and a missed sweep
   * self-corrects on the next one because the check is "is it due?", not "did
   * the timer fire?".
   */
  const sweepEveryMs = intEnv('ATLAS_SWEEP_INTERVAL_MS', { fallback: 60_000, min: 1_000 });
  let lastSweep = 0;

  while (!stop.requested()) {
    if (Date.now() - lastSweep >= sweepEveryMs) {
      lastSweep = Date.now();
      try {
        const queued = await scheduleWeeklyReviews(pool);
        if (queued > 0) console.log(`workers: queued ${queued} weekly review(s)`);
      } catch (err) {
        // A failed sweep must not kill the loop that drains the queue; the next
        // sweep re-evaluates from scratch.
        console.error('workers: weekly-review sweep failed', err);
      }
    }

    const n = await runner.tick();
    // sleep() returns early on a stop request, so a shutdown does not wait out
    // the poll interval before noticing.
    if (n === 0) await stop.sleep(2000);
  }
  console.log('workers: loop stopped');
}
