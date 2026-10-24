-- Migration 041: rewrite api_tokens ids to UUIDs and keep only a real fingerprint
-- File: 041_update_api_tokens_id.sql
-- Date: 2026-10-24 14:00
-- Dialect: Postgres
-- Depends on: 040
-- Ref: docs/评审-全面代码审查-20261024.md (P0-2); decision #27 in docs/待拍板决策清单-20260910.md
-- Note: Postgres dialect. Same change as the SQLite migration (column set must
--       match, migrations-parity test). Migration 027 stored the plaintext
--       bearer token in api_tokens.id, so a dump exposed valid 90-day tokens
--       and the authorization list echoed the id back. Adds token_last4, backfills
--       it from the legacy plaintext id, then rewrites legacy ids to UUIDs.
--       token_hash is untouched, so issued Bearer tokens keep working. The id
--       rewrite is irreversible by design: old ids WERE credentials.

ALTER TABLE api_tokens ADD COLUMN token_last4 TEXT NOT NULL DEFAULT '';

-- Backfill BEFORE rewriting ids: legacy ids ARE the plaintext tokens.
UPDATE api_tokens SET token_last4 = right(id, 4) WHERE token_last4 = '';

-- Only legacy ids carry the tkn- prefix, so re-running this statement is a no-op.
UPDATE api_tokens SET id = gen_random_uuid()::text WHERE id LIKE 'tkn-%';

COMMENT ON COLUMN api_tokens.id IS 'opaque token id (UUID); never the token itself (migration 041)';
COMMENT ON COLUMN api_tokens.token_last4 IS 'last 4 characters of the issued token, shown in the authorization list; never reversible to the token';

-- DOWN BEGIN
-- The id rewrite is irreversible (the old ids were plaintext credentials and
-- must never be restored). Rolling back only removes the fingerprint column.
ALTER TABLE api_tokens DROP COLUMN token_last4;
-- DOWN END
