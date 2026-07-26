/**
 * @atlas/lifecycle — process shutdown and crash handling.
 *
 * No entry point registered a single `process.on` handler. Measured:
 *
 *   * SIGTERM during a 3s request: `curl exit=52 http=000` — the connection was
 *     severed mid-response and the process died instantly. Every deploy did
 *     this to whatever was in flight, including SSE Copilot streams and
 *     multi-statement writes.
 *   * An unhandled rejection: `exit=1` before a 500ms timer could fire. Node
 *     exits by default, and with nothing supervising the process it stays down
 *     until a human notices.
 *
 * Three rules:
 *
 *  1. Stop accepting work, THEN close resources. Reversing the order cuts off
 *     in-flight requests at the database, which is the failure this exists to
 *     prevent.
 *  2. Bound the wait. A shutdown that hangs is worse than an abrupt one,
 *     because the supervisor's SIGKILL arrives at an arbitrary moment instead
 *     of a chosen one.
 *  3. Say why. A process that exits silently is indistinguishable from one that
 *     was killed, and P0-2 exists because that distinction was unavailable.
 */
import { intEnv } from '@atlas/config';

export interface ShutdownTask {
  /** Named so a hung shutdown says which step is hanging. */
  name: string;
  run: () => Promise<void>;
}

export interface Logger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** Falls back to console when a process has no structured logger. */
const consoleLogger: Logger = {
  info: (obj, msg) => console.log(`[lifecycle] ${msg}`, obj),
  error: (obj, msg) => console.error(`[lifecycle] ${msg}`, obj),
};

export interface LifecycleOptions {
  tasks: ShutdownTask[];
  logger?: Logger;
  /** Hard ceiling on the whole sequence. Read per call so a test can shorten it. */
  graceMs?: number;
  /** Injected so tests can observe the exit instead of dying. */
  exit?: (code: number) => void;
}

function graceMsDefault(): number {
  // Long enough for an in-flight request and a pool drain; short enough to beat
  // the SIGKILL most supervisors send at 30s.
  return intEnv('ATLAS_SHUTDOWN_GRACE_MS', { fallback: 10_000, min: 1 });
}

/**
 * Runs the shutdown tasks in order, bounded by `graceMs`. Idempotent: a second
 * signal while a shutdown is already running does not start another one.
 */
export function createShutdown(opts: LifecycleOptions): (reason: string, code: number) => void {
  const log = opts.logger ?? consoleLogger;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  return function shutdown(reason: string, code: number): void {
    if (shuttingDown) {
      // A second signal means the operator is insisting. Honour it.
      log.info({ reason }, 'shutdown already in progress — exiting immediately');
      exit(code);
      return;
    }
    shuttingDown = true;
    log.info({ reason }, 'shutting down');

    const deadline = setTimeout(() => {
      log.error({ reason, graceMs: opts.graceMs ?? graceMsDefault() }, 'shutdown timed out — exiting anyway');
      exit(code);
    }, opts.graceMs ?? graceMsDefault());
    // Never let the timer alone keep the event loop alive.
    deadline.unref?.();

    void (async () => {
      for (const task of opts.tasks) {
        try {
          await task.run();
          log.info({ task: task.name }, 'shutdown step complete');
        } catch (err) {
          // One failing step must not strand the rest: a pool that refuses to
          // close should not prevent the server from stopping.
          log.error({ task: task.name, err: String(err) }, 'shutdown step failed');
        }
      }
      clearTimeout(deadline);
      log.info({ reason }, 'shutdown complete');
      exit(code);
    })();
  };
}

/**
 * Register the handlers a long-running process needs.
 *
 * `uncaughtException` and `unhandledRejection` exit non-zero after running the
 * same shutdown path: the process state is unknown after either, so continuing
 * would be a guess. Exiting cleanly is what lets a supervisor restart into a
 * known state — and the log line is what makes the restart explicable.
 */
export function installLifecycle(opts: LifecycleOptions): () => void {
  const log = opts.logger ?? consoleLogger;
  const shutdown = createShutdown(opts);

  const onSigterm = () => shutdown('SIGTERM', 0);
  const onSigint = () => shutdown('SIGINT', 0);
  const onUncaught = (err: unknown) => {
    log.error({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, 'uncaught exception');
    shutdown('uncaughtException', 1);
  };
  const onUnhandled = (reason: unknown) => {
    log.error(
      { err: reason instanceof Error ? reason.stack ?? reason.message : String(reason) },
      'unhandled rejection',
    );
    shutdown('unhandledRejection', 1);
  };

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);

  return () => {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  };
}

/**
 * A cooperative stop flag for loops that must finish their current unit of work
 * before exiting — the worker's `watch` tick, above all. Killing a worker
 * mid-job is survivable (the lease expires and another worker reclaims it,
 * migration 020), but finishing the tick avoids the delay and the extra attempt.
 */
export class StopSignal {
  private stopped = false;
  private waiters: Array<() => void> = [];

  requested(): boolean {
    return this.stopped;
  }

  request(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Sleep that returns early when a stop is requested. */
  async sleep(ms: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onStop);
        resolve();
      }, ms);
      const onStop = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onStop);
    });
  }
}
