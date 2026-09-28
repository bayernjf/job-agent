import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';

/**
 * Ordering comparisons for the TEXT ISO-8601 timestamp columns.
 *
 * Every timestamp-ish column is stored as `text` (see schema.ts) so that the
 * SQLite and PostgreSQL schemas stay identical. Binding an ISO string through
 * the extended query protocol against a transaction pooler (Supabase
 * PgBouncer/Supavisor on :6543) can leave the parameter's type unresolved at
 * Parse time; Postgres then infers it as `timestamptz`, and the comparison
 * fails with `42883 operator does not exist: text < timestamp with time zone`,
 * which 500s the cron worker's stale-job reclaim.
 *
 * Pinning the bound parameter to `::text` makes the comparison unambiguously
 * text-to-text on every Postgres path (direct / pooled, prepared or not).
 * SQLite has no `::text` cast, so these helpers are Postgres-only; the SQLite
 * repositories keep using drizzle's `lt/gt/...` (TEXT affinity is permissive).
 */
export const tsLt = (column: AnyColumn, iso: string): SQL =>
  sql`${column} < ${iso}::text`;
export const tsLte = (column: AnyColumn, iso: string): SQL =>
  sql`${column} <= ${iso}::text`;
export const tsGt = (column: AnyColumn, iso: string): SQL =>
  sql`${column} > ${iso}::text`;
export const tsGte = (column: AnyColumn, iso: string): SQL =>
  sql`${column} >= ${iso}::text`;
