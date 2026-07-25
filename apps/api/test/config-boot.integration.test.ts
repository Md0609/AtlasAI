/**
 * Boot-time configuration refusal (P1-13).
 *
 * A misconfigured deploy used to start successfully and behave wrongly. These
 * pin the refusals at the point they matter — the values a running API reads —
 * rather than only at the parser level.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@atlas/config';
import { assertDatabaseConfig } from '@atlas/schema';
// Direct source import rather than @atlas/api/internal: that module is dead
// (P2-16) and reviving it to reach one function would be the wrong direction.
import { tlsExpected } from '../src/auth.js';

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('database configuration', () => {
  it('refuses the published development database in production', () => {
    // These credentials are in this repository. A deploy that reaches them is a
    // credential compromise, not a configuration slip.
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_DATABASE_URL = 'postgres://atlas:atlas@127.0.0.1:5432/atlas';
    expect(() => assertDatabaseConfig()).toThrow(/development database/);
  });

  it('requires a URL at all in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ATLAS_DATABASE_URL;
    expect(() => assertDatabaseConfig()).toThrow(ConfigError);
  });

  it('rejects a non-postgres URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_DATABASE_URL = 'mysql://u:p@host/db';
    expect(() => assertDatabaseConfig()).toThrow(/postgres/);
  });

  it('accepts a real production URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_DATABASE_URL = 'postgres://atlas:s3cret@db.internal:5432/atlas';
    expect(() => assertDatabaseConfig()).not.toThrow();
  });

  it('leaves development alone — the suite must not need credentials', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ATLAS_DATABASE_URL;
    expect(() => assertDatabaseConfig()).not.toThrow();
  });
});

describe('ATLAS_COOKIE_SECURE decides both the Secure flag and HSTS', () => {
  it('reads the forms an operator actually writes', () => {
    // `x === 'true'` read all of these except the first as false, so an
    // operator who believed they had enabled Secure cookies had not.
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
      process.env.ATLAS_COOKIE_SECURE = v;
      expect(tlsExpected(), `${v} should enable TLS expectations`).toBe(true);
    }
    for (const v of ['false', '0', 'no', 'off']) {
      process.env.ATLAS_COOKIE_SECURE = v;
      expect(tlsExpected(), `${v} should disable them`).toBe(false);
    }
  });

  it('throws on an unparseable value rather than silently disabling security', () => {
    process.env.ATLAS_COOKIE_SECURE = 'oui';
    expect(() => tlsExpected()).toThrow(ConfigError);
  });

  it('defaults to on in production and off elsewhere', () => {
    delete process.env.ATLAS_COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    expect(tlsExpected()).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(tlsExpected()).toBe(false);
  });
});
