/**
 * Process lifecycle (P0-6).
 *
 * Measured before this existed:
 *
 *   * SIGTERM during a 3s request -> `curl exit=52 http=000`. The connection
 *     was severed mid-response and the process died instantly. Every deploy did
 *     this to whatever was in flight.
 *   * `Promise.reject(new Error('boom'))` -> `exit=1` before a 500ms timer
 *     could fire. Node exits on an unhandled rejection by default, and nothing
 *     restarted the process.
 *
 * `exit` is injected throughout so these observe the decision instead of
 * killing the test runner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StopSignal, createShutdown, installLifecycle } from '../src/index.js';

const exits: number[] = [];
const exit = (code: number) => {
  exits.push(code);
};
const silent = { info: () => {}, error: () => {} };

afterEach(() => {
  exits.length = 0;
});

/** Wait for the shutdown's async task loop to settle. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('shutdown', () => {
  it('runs tasks in the order given', async () => {
    // Order is the whole point: stop accepting work, THEN close the pool.
    // Reversing it cuts off in-flight requests at the database.
    const order: string[] = [];
    const shutdown = createShutdown({
      logger: silent,
      exit,
      tasks: [
        { name: 'http', run: async () => void order.push('http') },
        { name: 'database', run: async () => void order.push('database') },
      ],
    });

    shutdown('SIGTERM', 0);
    await settle();
    expect(order).toEqual(['http', 'database']);
    expect(exits).toEqual([0]);
  });

  it('continues when a task fails, so one bad step cannot strand the rest', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      logger: silent,
      exit,
      tasks: [
        { name: 'broken', run: async () => { throw new Error('will not close'); } },
        { name: 'database', run: async () => void order.push('database') },
      ],
    });

    shutdown('SIGTERM', 0);
    await settle();
    // A pool that refuses to close must not prevent the process from stopping.
    expect(order).toEqual(['database']);
    expect(exits).toEqual([0]);
  });

  it('exits immediately on a second signal', async () => {
    // The operator is insisting. Honour it rather than waiting out the grace.
    let release: (() => void) | undefined;
    const shutdown = createShutdown({
      logger: silent,
      exit,
      graceMs: 5_000,
      tasks: [{ name: 'slow', run: () => new Promise<void>((r) => { release = r; }) }],
    });

    shutdown('SIGTERM', 0);
    await settle();
    expect(exits).toEqual([]); // still draining

    shutdown('SIGTERM', 0);
    expect(exits).toEqual([0]); // second signal exits at once
    release?.();
  });

  it('exits anyway when a task hangs past the grace period', async () => {
    // A shutdown that hangs is worse than an abrupt one: the supervisor's
    // SIGKILL then lands at an arbitrary moment instead of a chosen one.
    const shutdown = createShutdown({
      logger: silent,
      exit,
      graceMs: 20,
      tasks: [{ name: 'hangs', run: () => new Promise<void>(() => {}) }],
    });

    shutdown('SIGTERM', 0);
    await new Promise((r) => setTimeout(r, 80));
    expect(exits).toEqual([0]);
  });
});

describe('crash handlers', () => {
  it('exits non-zero on an unhandled rejection, after draining', async () => {
    const order: string[] = [];
    const uninstall = installLifecycle({
      logger: silent,
      exit,
      tasks: [{ name: 'database', run: async () => void order.push('database') }],
    });

    try {
      process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
      await settle();
      // Non-zero so a supervisor knows this was a fault, not a clean stop.
      expect(exits).toEqual([1]);
      // …and resources still get closed on the way out.
      expect(order).toEqual(['database']);
    } finally {
      uninstall();
    }
  });

  it('exits non-zero on an uncaught exception', async () => {
    const uninstall = installLifecycle({ logger: silent, exit, tasks: [] });
    try {
      process.emit('uncaughtException', new Error('boom'));
      await settle();
      expect(exits).toEqual([1]);
    } finally {
      uninstall();
    }
  });

  it('exits zero on SIGTERM — a deploy is not a fault', async () => {
    const uninstall = installLifecycle({ logger: silent, exit, tasks: [] });
    try {
      process.emit('SIGTERM');
      await settle();
      expect(exits).toEqual([0]);
    } finally {
      uninstall();
    }
  });

  it('removes its handlers when uninstalled, leaving no listener leak', () => {
    const before = process.listenerCount('SIGTERM');
    const uninstall = installLifecycle({ logger: silent, exit, tasks: [] });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    uninstall();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('logs the reason, so a restart is explicable', async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const uninstall = installLifecycle({ logger: log, exit, tasks: [] });
    try {
      process.emit('unhandledRejection', new Error('the specific cause'), Promise.resolve());
      await settle();
      // P0-2 exists because a silent exit is indistinguishable from a kill.
      const logged = JSON.stringify(log.error.mock.calls);
      expect(logged).toContain('the specific cause');
    } finally {
      uninstall();
    }
  });
});

describe('StopSignal', () => {
  it('lets a loop finish its current unit of work', async () => {
    // The worker's watch tick. Killing it mid-job is survivable — the lease
    // expires and another worker reclaims it — but it costs a delay and an
    // attempt for nothing.
    const stop = new StopSignal();
    const done: number[] = [];
    const loop = (async () => {
      let i = 0;
      while (!stop.requested()) {
        done.push(++i);
        await stop.sleep(20);
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    stop.request();
    await loop;

    expect(stop.requested()).toBe(true);
    expect(done.length).toBeGreaterThan(0);
  });

  it('wakes a sleeping loop immediately rather than waiting out the interval', async () => {
    const stop = new StopSignal();
    const started = Date.now();
    const sleeping = stop.sleep(5_000);
    setTimeout(() => stop.request(), 20);
    await sleeping;
    // Without the early wake, a shutdown would wait the full poll interval.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is idempotent', () => {
    const stop = new StopSignal();
    stop.request();
    stop.request();
    expect(stop.requested()).toBe(true);
  });
});
