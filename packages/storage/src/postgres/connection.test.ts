import { describe, expect, it } from 'vitest';
import { resolvePostgresOptions } from './connection.js';

describe('resolvePostgresOptions', () => {
  it('maps sslmode=require/verify-ca/verify-full to strict TLS verification', () => {
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      const opts = resolvePostgresOptions(
        `postgresql://u:p@host:5432/db?sslmode=${mode}`,
      );
      expect(opts.ssl).toEqual({ rejectUnauthorized: true });
    }
  });

  it('maps sslmode=no-verify to TLS without chain verification', () => {
    const opts = resolvePostgresOptions(
      'postgresql://u:p@host:5432/db?sslmode=no-verify',
    );
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('leaves ssl unset for unsupported sslmode values', () => {
    const opts = resolvePostgresOptions(
      'postgresql://u:p@host:5432/db?sslmode=disable',
    );
    expect(opts.ssl).toBeUndefined();
  });

  it('detects pgbouncer transaction pooling for 6543 and disables prepared statements', () => {
    const opts = resolvePostgresOptions(
      'postgresql://u:p@host:6543/db?sslmode=require',
    );
    expect(opts.prepare).toBe(false);
    expect(opts.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('lets explicit ssl option override sslmode mapping', () => {
    const opts = resolvePostgresOptions(
      'postgresql://u:p@host:5432/db?sslmode=require',
      { ssl: { rejectUnauthorized: false } },
    );
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('falls back to defaults when the url cannot be parsed', () => {
    const opts = resolvePostgresOptions('not-a-url');
    expect(opts.max).toBe(10);
    expect(opts.ssl).toBeUndefined();
  });
});
