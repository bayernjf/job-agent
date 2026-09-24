import { describe, it, expect } from 'vitest';
import { resolveSqliteDbPath } from './cli-config.js';

const DEFAULT = '/repo/data/job-agent.db';

describe('resolveSqliteDbPath', () => {
  it('prefers an explicit argument over DB_PATH and the default', () => {
    const resolved = resolveSqliteDbPath({
      argument: '/tmp/other.db',
      env: { DB_PATH: '/tmp/from-env.db' },
      defaultPath: DEFAULT,
    });
    expect(resolved).toEqual({ path: '/tmp/other.db', source: 'argument' });
  });

  it('falls back to DB_PATH when no argument is given', () => {
    const resolved = resolveSqliteDbPath({ env: { DB_PATH: '/tmp/from-env.db' }, defaultPath: DEFAULT });
    expect(resolved).toEqual({ path: '/tmp/from-env.db', source: 'DB_PATH' });
  });

  it('keeps the default when DB_PATH is unset or blank', () => {
    expect(resolveSqliteDbPath({ env: {}, defaultPath: DEFAULT }).source).toBe('default');
    expect(resolveSqliteDbPath({ env: { DB_PATH: '' }, defaultPath: DEFAULT })).toEqual({
      path: DEFAULT,
      source: 'default',
    });
    expect(resolveSqliteDbPath({ env: { DB_PATH: '   ' }, defaultPath: DEFAULT }).source).toBe('default');
    expect(resolveSqliteDbPath({ argument: '  ', env: {}, defaultPath: DEFAULT }).source).toBe('default');
  });

  it('returns the selected value verbatim so relative paths stay cwd-relative', () => {
    // createStorage() hands the string straight to better-sqlite3; resolving here
    // would make `migrate:up` and the running services point at different files.
    const resolved = resolveSqliteDbPath({ env: { DB_PATH: 'data/relative.db' }, defaultPath: DEFAULT });
    expect(resolved.path).toBe('data/relative.db');
  });

  it('accepts the :memory: special name', () => {
    expect(resolveSqliteDbPath({ env: { DB_PATH: ':memory:' }, defaultPath: DEFAULT }).path).toBe(':memory:');
  });
});
