import type { ColumnRequirement } from '../types.js';

/**
 * 迁移漂移守卫（SQLite 方言）：直接查实际 schema，返回缺失的 "table.column" 列表。
 * PRAGMA table_info 直接反映实际 schema；表不存在时返回空集 → 该表所有列报缺失。
 * 刻意不读 schema_migrations 账本（手工重放的迁移无记录，读账本会误报）。
 */
export function sqliteVerifyRequiredColumns(
  client: { prepare(sql: string): { all(...args: unknown[]): Array<{ name: string }> } },
  requirements: ColumnRequirement[],
): string[] {
  const missing: string[] = [];
  for (const { table, column } of requirements) {
    const cols = client.prepare('SELECT name FROM pragma_table_info(?)').all(table);
    if (!cols.some((c) => c.name === column)) missing.push(`${table}.${column}`);
  }
  return missing;
}
