/**
 * @atlas/config — environment parsing that refuses to guess.
 *
 * Every production-critical setting had a silently-working default and no
 * validation. Measured, not inferred:
 *
 *   ATLAS_ERASURE_GRACE_DAYS=abc      -> Number NaN  -> scheduled_for "Invalid Date"
 *   ATLAS_ERASURE_GRACE_DAYS=""       -> 0           -> erasure due immediately
 *   ATLAS_ERASURE_GRACE_DAYS=-5       -> -5          -> erasure due five days ago
 *   ATLAS_RATE_LIMIT_LOGIN=abc        -> NaN         -> limiter in an undefined state
 *   ATLAS_LLM_TIMEOUT_MS=0            -> 0           -> every call times out
 *   ATLAS_COOKIE_SECURE=TRUE          -> false       -> no Secure flag, no HSTS
 *   ATLAS_COOKIE_SECURE=1             -> false       -> same
 *   PORT=abc                          -> NaN
 *
 * The boolean cases are the nastiest: `1` and `TRUE` are the natural ways to
 * write "yes", and both failed to the INSECURE side while looking configured.
 *
 * Three rules:
 *
 *  1. Invalid is never a value. Junk throws; it does not become NaN, 0, or
 *     `false`. A process that cannot parse its own configuration must not
 *     start with a guess.
 *  2. Development defaults are legitimate and stay. Requiring credentials to
 *     run tests would be the wrong trade; §B8 is explicitly mock-first.
 *  3. Production is where defaults become dangerous, so `assertProductionConfig`
 *     is what refuses to boot — reporting EVERY problem at once, because
 *     fixing a misconfigured deploy one restart at a time is its own outage.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Absent and empty are the same thing: `FOO=` in a shell means "not set". */
function raw(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export interface IntOptions {
  /** Used when the variable is absent. Omit to make it required. */
  fallback?: number;
  min?: number;
  max?: number;
}

/**
 * A finite integer, or an error. Rejects NaN, Infinity, fractions and
 * out-of-range values rather than passing them downstream where they become an
 * Invalid Date or a limiter of NaN.
 */
export function intEnv(name: string, opts: IntOptions = {}): number {
  const v = raw(name);
  if (v === undefined) {
    if (opts.fallback === undefined) throw new ConfigError(`${name} is required`);
    return opts.fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${name}="${v}" is not a finite number`);
  }
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${name}="${v}" must be a whole number`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new ConfigError(`${name}=${n} is below the minimum of ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new ConfigError(`${name}=${n} is above the maximum of ${opts.max}`);
  }
  return n;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * A boolean that accepts the forms people actually write, and rejects anything
 * else loudly.
 *
 * The previous `x === 'true'` silently read `TRUE`, `1` and `yes` as false. For
 * ATLAS_COOKIE_SECURE that meant an operator who believed they had enabled
 * Secure cookies and HSTS had done neither.
 */
export function boolEnv(name: string, opts: { fallback?: boolean } = {}): boolean {
  const v = raw(name);
  if (v === undefined) {
    if (opts.fallback === undefined) throw new ConfigError(`${name} is required`);
    return opts.fallback;
  }
  const lower = v.toLowerCase();
  if (TRUE.has(lower)) return true;
  if (FALSE.has(lower)) return false;
  throw new ConfigError(
    `${name}="${v}" is not a boolean. Use one of: ${[...TRUE, ...FALSE].join(', ')}.`,
  );
}

export function stringEnv(name: string, opts: { fallback?: string } = {}): string {
  const v = raw(name);
  if (v === undefined) {
    if (opts.fallback === undefined) throw new ConfigError(`${name} is required`);
    return opts.fallback;
  }
  return v;
}

/** A syntactically valid postgres:// or postgresql:// URL. */
export function postgresUrlEnv(name: string, opts: { fallback?: string } = {}): string {
  const v = stringEnv(name, opts);
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConfigError(`${name} must be a postgres:// URL, got "${parsed.protocol}//"`);
  }
  return v;
}

/**
 * The development database, published in this repository and in every developer's
 * shell history. Reaching a production process is a credential compromise, not a
 * configuration slip.
 */
export const DEV_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:5432/atlas';

/**
 * Validate the whole environment at once and refuse to boot on any problem.
 *
 * Called from a process entry point before anything else. Collects every error
 * rather than throwing on the first: a deploy that has three variables wrong
 * should learn that once, not across three restarts.
 *
 * `checks` lets each process declare what IT needs — the API and the workers do
 * not read the same variables — without this module knowing their internals.
 */
export function assertConfig(checks: Array<() => void>): void {
  const errors: string[] = [];
  for (const check of checks) {
    try {
      check();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new ConfigError(
      `Refusing to start — ${errors.length} configuration problem${errors.length > 1 ? 's' : ''}:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}
