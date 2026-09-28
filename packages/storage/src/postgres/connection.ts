import postgres from 'postgres';
import type { Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/** postgres-js 构造选项类型（直接取库函数签名，避免泛型版本在不同小版本间漂移） */
type PostgresOptions = NonNullable<Parameters<typeof postgres>[1]>;

/**
 * Postgres 连接工厂（仅持久化层内部使用，驱动 postgres-js，技术选型 §6.5 指定）。
 * 仓储通过显式表对象查询，因此不向 drizzle 注入 schema 泛型，保持构造参数裸类型一致。
 *
 * 托管池化适配（Supabase / PgBouncer）：
 * - 连接串带 `?pgbouncer=true`，或端口为 Supabase 事务池化端口 6543 时，
 *   自动 `prepare: false`——事务池化不支持会话级 prepared statement 复用，
 *   否则会报 "prepared statement already exists / does not exist"。
 * - 迁移/DDL 请走会话池化/直连（5432），不要用事务池化串（见部署 Runbook 形态 C）。
 * - `sslmode=require|verify-ca|verify-full` 时显式开启 TLS 并校验证书链；
 *   `sslmode=no-verify` 时开启 TLS 但跳过链校验（标准 sslmode，适用于私有 CA 或
 *   临时环境的运维连接）。注意：Supabase pooler 证书由 Supabase 私有 CA
 *   （Supabase Intermediate 2021 CA）签发，Node 内置信任库不包含该 CA，
 *   `require` 在本机/云端默认会报 "self-signed certificate in certificate chain"，
 *   迁移/预热等运维连接请使用 `no-verify`。
 */
export interface PgConnection {
  /** postgres-js 标签模板客户端（迁移器、事务也用它） */
  client: Sql;
  db: PostgresJsDatabase;
}

export interface PgOpenOptions {
  /** 连接池大小（默认 10；serverless 建议显式调小，如 1–3） */
  max?: number;
  /** 覆盖 prepared statements 开关；不传则按 pgbouncer/端口自动判定 */
  prepare?: boolean;
  /** 覆盖 TLS 选项；不传则按 sslmode 自动判定 */
  ssl?: PostgresOptions['ssl'];
}

/** Supabase 事务池化（PgBouncer transaction mode）默认端口。 */
const SUPABASE_TRANSACTION_POOLER_PORT = '6543';

export function resolvePostgresOptions(databaseUrl: string, options?: PgOpenOptions): PostgresOptions {
  let pgbouncer = false;
  let sslmode: string | null = null;
  try {
    const parsed = new URL(databaseUrl);
    pgbouncer =
      parsed.searchParams.get('pgbouncer') === 'true' ||
      parsed.port === SUPABASE_TRANSACTION_POOLER_PORT;
    sslmode = parsed.searchParams.get('sslmode');
  } catch {
    // 非标准连接串时退化为默认值（prepared 开启、TLS 按 postgres-js 默认）
  }

  const resolved: PostgresOptions = {
    max: options?.max ?? 10,
    prepare: options?.prepare ?? (pgbouncer ? false : undefined),
  };

  const ssl =
    options?.ssl ??
    (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full'
      ? // 校验证书链；verify-full 的主机名校验由 TLS 默认行为覆盖
        { rejectUnauthorized: true }
      : sslmode === 'no-verify'
        ? // 保持 TLS 加密但跳过链校验（私有 CA / 运维连接的临时信任）
          { rejectUnauthorized: false }
        : undefined);
  if (ssl !== undefined) {
    resolved.ssl = ssl;
  }

  return resolved;
}

export function openPostgres(databaseUrl: string, options?: PgOpenOptions): PgConnection {
  const resolved = resolvePostgresOptions(databaseUrl, options);
  // Opt-in diagnostics (JA_PG_DIAG=1): log the *shape* of the resolved
  // connection, never credentials. Used to diagnose production driver issues
  // (e.g. Vercel serverless) where the runtime connection differs from local.
  if (process.env.JA_PG_DIAG === '1') {
    let host = '?';
    let port = '(default)';
    let sslmode = '(default)';
    try {
      const u = new URL(databaseUrl);
      host = u.hostname;
      if (u.port) port = u.port;
      if (u.searchParams.get('sslmode')) sslmode = u.searchParams.get('sslmode') as string;
    } catch {
      host = '(unparseable url)';
    }
    console.info(
      '[diag:pg] open ' +
        JSON.stringify({
          host,
          port,
          sslmode,
          prepare: resolved.prepare === undefined ? '(default true)' : resolved.prepare,
          max: resolved.max,
          node: process.versions.node,
        }),
    );
  }
  const client = postgres(databaseUrl, resolved);
  const db = drizzle(client);
  return { client, db };
}
