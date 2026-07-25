/**
 * Configuration parsing (P1-13).
 *
 * Every case below was measured against the previous code before being written.
 * The behaviours these tests forbid are not hypothetical:
 *
 *   ATLAS_ERASURE_GRACE_DAYS=abc  -> NaN -> "Invalid Date" in a GDPR deadline
 *   ATLAS_ERASURE_GRACE_DAYS=""   -> 0   -> erasure due immediately
 *   ATLAS_ERASURE_GRACE_DAYS=-5   -> -5  -> erasure due five days ago
 *   ATLAS_RATE_LIMIT_LOGIN=abc    -> NaN -> limiter in an undefined state
 *   ATLAS_LLM_TIMEOUT_MS=0        -> 0   -> every provider call times out
 *   ATLAS_COOKIE_SECURE=TRUE      -> false, silently: no Secure flag, no HSTS
 *   ATLAS_COOKIE_SECURE=1         -> false, silently
 *   PORT=abc                      -> NaN
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_DATABASE_URL,
  assertConfig,
  boolEnv,
  intEnv,
  postgresUrlEnv,
  stringEnv,
} from '../src/index.js';

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

const set = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

describe('intEnv', () => {
  it('rejects junk instead of yielding NaN', () => {
    set('T_INT', 'abc');
    expect(() => intEnv('T_INT', { fallback: 30 })).toThrow(/not a finite number/);
  });

  it.each(['Infinity', '-Infinity', '1e999'])('rejects %s', (v) => {
    set('T_INT', v);
    expect(() => intEnv('T_INT', { fallback: 30 })).toThrow(ConfigError);
  });

  it('treats an empty string as absent, not as zero', () => {
    // `FOO=` in a shell or a compose file means "not set". Reading it as 0 is
    // how an empty grace period became an immediate erasure.
    set('T_INT', '');
    expect(intEnv('T_INT', { fallback: 30 })).toBe(30);
  });

  it('rejects fractions where a whole number is meant', () => {
    set('T_INT', '0.5');
    expect(() => intEnv('T_INT', { fallback: 30 })).toThrow(/whole number/);
  });

  it('enforces bounds in both directions', () => {
    set('T_INT', '-5');
    expect(() => intEnv('T_INT', { fallback: 30, min: 1 })).toThrow(/below the minimum/);
    set('T_INT', '999');
    expect(() => intEnv('T_INT', { fallback: 30, max: 30 })).toThrow(/above the maximum/);
  });

  it('requires a value when no fallback is given', () => {
    set('T_INT', undefined);
    expect(() => intEnv('T_INT')).toThrow(/is required/);
  });
});

describe('boolEnv', () => {
  it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on'])('reads %s as true', (v) => {
    // The old `x === 'true'` read every one of these except the first as FALSE.
    // For ATLAS_COOKIE_SECURE that silently meant no Secure flag and no HSTS,
    // while looking configured.
    set('T_BOOL', v);
    expect(boolEnv('T_BOOL', { fallback: false })).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('reads %s as false', (v) => {
    set('T_BOOL', v);
    expect(boolEnv('T_BOOL', { fallback: true })).toBe(false);
  });

  it('throws on anything else rather than defaulting to false', () => {
    // Failing loudly beats failing to the insecure side.
    set('T_BOOL', 'oui');
    expect(() => boolEnv('T_BOOL', { fallback: false })).toThrow(/is not a boolean/);
  });

  it('falls back when absent or empty', () => {
    set('T_BOOL', undefined);
    expect(boolEnv('T_BOOL', { fallback: true })).toBe(true);
    set('T_BOOL', '');
    expect(boolEnv('T_BOOL', { fallback: true })).toBe(true);
  });
});

describe('postgresUrlEnv', () => {
  it('accepts postgres:// and postgresql://', () => {
    set('T_URL', 'postgresql://u:p@host:5432/db');
    expect(postgresUrlEnv('T_URL')).toBe('postgresql://u:p@host:5432/db');
  });

  it('rejects a non-postgres scheme and unparseable junk', () => {
    set('T_URL', 'https://example.com');
    expect(() => postgresUrlEnv('T_URL')).toThrow(/must be a postgres/);
    set('T_URL', 'not a url');
    expect(() => postgresUrlEnv('T_URL')).toThrow(/not a valid URL/);
  });
});

describe('stringEnv', () => {
  it('requires a value when no fallback is given', () => {
    set('T_STR', undefined);
    expect(() => stringEnv('T_STR')).toThrow(/is required/);
  });
});

describe('assertConfig', () => {
  it('reports every problem at once, not one per restart', () => {
    // A deploy with three variables wrong should learn that once.
    set('A', 'abc');
    set('B', 'oui');
    let message = '';
    try {
      assertConfig([
        () => intEnv('A', { fallback: 1 }),
        () => boolEnv('B', { fallback: false }),
        () => stringEnv('C'),
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('3 configuration problems');
    expect(message).toContain('A="abc"');
    expect(message).toContain('B="oui"');
    expect(message).toContain('C is required');
  });

  it('passes silently when everything is valid', () => {
    expect(() => assertConfig([() => intEnv('NOPE', { fallback: 1 })])).not.toThrow();
  });
});

describe('the development database must not reach production', () => {
  it('exposes the published dev URL so callers can refuse it', () => {
    // These credentials are in this repository and in every developer's shell
    // history. Reaching a real deployment is a compromise, not a slip.
    expect(DEV_DATABASE_URL).toContain('atlas:atlas@127.0.0.1');
  });
});
