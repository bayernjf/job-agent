import { describe, expect, it } from 'vitest';
import * as sqliteSchema from './sqlite/schema.js';
import * as pgSchema from './postgres/schema.js';

/**
 * 双方言 Drizzle schema 结构一致性（无数据库实例）：
 * 两套表定义的 JS 属性名（camelCase）与物理列名（snake_case）必须逐一对齐，
 * 这样 entities 的 Raw*Row 行类型才能被两方言查询结果共用。
 */

interface DrizzleColumn {
  name: string;
  columnType: string;
}

function isColumn(value: unknown): value is DrizzleColumn {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'columnType' in value
  );
}

/** 返回 { jsKey: physicalColumnName } */
function columnMap(table: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (isColumn(value)) out[key] = value.name;
  }
  return out;
}

const TABLES = [
  'profiles',
  'analysisJobs',
  'evidence',
  'waitlist',
  'jobPostings',
  'demoSessions',
  'demoRateEvents',
  'applications',
  'interviews',
  'accounts',
  'authSessions',
] as const;

describe('sqlite/postgres schema parity', () => {
  it.each(TABLES)('table %s exposes identical JS keys and physical columns', (tableKey) => {
    const sqliteColumns = columnMap(sqliteSchema[tableKey]);
    const pgColumns = columnMap(pgSchema[tableKey]);

    expect(Object.keys(pgColumns).sort()).toEqual(Object.keys(sqliteColumns).sort());
    expect(Object.values(pgColumns).sort()).toEqual(Object.values(sqliteColumns).sort());
  });
});
