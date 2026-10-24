-- Migration 041: rewrite api_tokens ids to UUIDs and keep only a real fingerprint
-- File: 041_update_api_tokens_id.sql
-- Date: 2026-10-24 14:00
-- Dialect: SQLite
-- Depends on: 040
-- Ref: docs/评审-全面代码审查-20261024.md (P0-2); decision #27 in docs/待拍板决策清单-20260910.md
-- Note: SQLite dialect. Migration 027 stored the plaintext bearer token in
--       api_tokens.id, which defeated the hash-only guarantee: a database dump
--       exposed valid 90-day tokens and GET /auth/extension-tokens echoed the
--       id back. This migration (1) adds token_last4 for the authorization
--       list's real fingerprint, (2) backfills it from the legacy plaintext id,
--       and (3) rewrites every legacy id to a random UUID. token_hash is
--       untouched, so already-issued Bearer tokens keep authenticating
--       (decision #27). The id rewrite is irreversible by design: old ids WERE
--       credentials and must never be restored.

ALTER TABLE api_tokens ADD COLUMN token_last4 TEXT NOT NULL DEFAULT '';

-- Backfill BEFORE rewriting ids: legacy ids ARE the plaintext tokens.
UPDATE api_tokens SET token_last4 = substr(id, -4) WHERE token_last4 = '';

-- Only legacy ids carry the tkn- prefix, so re-running this statement is a no-op.
UPDATE api_tokens
   SET id = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                  substr(hex(randomblob(2)), 2) || '-' ||
                  substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
                  '-' || hex(randomblob(6)))
 WHERE id LIKE 'tkn-%';

-- DOWN BEGIN
-- The id rewrite is irreversible (the old ids were plaintext credentials and
-- must never be restored). Rolling back only removes the fingerprint column.
ALTER TABLE api_tokens DROP COLUMN token_last4;
-- DOWN END
