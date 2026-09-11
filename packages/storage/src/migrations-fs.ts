import fs from 'node:fs';

/**
 * 迁移文件层（方言无关）：文件枚举与 up/down 段解析。
 * SQLite（同步）与 Postgres（异步）两套迁移器共用，避免解析规则漂移。
 */

export interface ParsedMigration {
  up: string;
  down: string | null;
}

/** 解析迁移文件：提取 up 段与可选 down 段（-- DOWN BEGIN ... -- DOWN END） */
export function parseMigrationFile(sql: string): ParsedMigration {
  const downMatch = sql.match(/--\s*DOWN\s*BEGIN([\s\S]*?)--\s*DOWN\s*END/);
  if (!downMatch) return { up: sql, down: null };
  return {
    up: sql.slice(0, downMatch.index ?? sql.length),
    down: downMatch[1]!.trim(),
  };
}

/** 列出迁移目录内合法的 NNN_verb_snake_case.sql，按编号排序 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_[a-z][a-z0-9_]*\.sql$/.test(f))
    .sort();
}

export interface RunMigrationsResult {
  /** 本次新应用的迁移文件名 */
  applied: string[];
  /** 目录内迁移文件总数 */
  total: number;
}

export interface RollbackResult {
  version: string;
  file: string;
}

/** 读取一个迁移文件并解析 */
export function readMigrationFile(migrationsDir: string, fileName: string): ParsedMigration {
  return parseMigrationFile(fs.readFileSync(`${migrationsDir}/${fileName}`, 'utf8'));
}

/**
 * 把一段 SQL 拆成可逐条执行的非空语句（剥离 -- 行注释，忽略字符串/标识符内分号）。
 * 仅适用于本项目不含存储过程/函数体/触发器、不含美元引用的简单 DDL。
 *
 * 用字符级状态机而非简单 split(';')：注释文本与 '...' 字符串内部可能含分号，
 * 简单按分号拆会把一条完整语句截断（导致 "syntax error at or near ..."）。
 * 正确处理：
 *   - `--` 行注释：整段跳过到行尾（其中分号不分割）
 *   - `'...'` 单引号字符串：其中分号不分割，`''` 为转义单引号
 *   - `"..."` 双引号标识符：其中分号不分割
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  const current: string[] = [];
  const n = script.length;
  let inSingle = false;
  let inDouble = false;

  const flush = (): void => {
    const stmt = current.join('').trim();
    if (stmt.length > 0) statements.push(stmt);
    current.length = 0;
  };

  for (let i = 0; i < n; ) {
    const ch = script[i]!;
    const next = script[i + 1];

    // 行注释 --：跳到行尾，不写入
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      while (i < n && script[i] !== '\n') i++;
      continue;
    }

    // 单引号字符串：处理 '' 转义
    if (ch === "'" && !inDouble) {
      if (inSingle && next === "'") {
        current.push("''");
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      current.push(ch);
      i++;
      continue;
    }

    // 双引号标识符
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current.push(ch);
      i++;
      continue;
    }

    // 语句分隔符（仅在不在字符串/标识符内时）
    if (ch === ';' && !inSingle && !inDouble) {
      flush();
      i++;
      continue;
    }

    current.push(ch);
    i++;
  }

  flush();
  return statements;
}
