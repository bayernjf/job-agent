-- Migration 017: add profile removal-requested hold flag to profiles
-- File: 017_add_profile_removal_requested_at.sql
-- Date: 2026-10-01 23:57
-- Depends on: 016
-- Ref: docs/design-profile-removal-request-20261001.md (audit S3)
-- Note: SQLite dialect. Denormalised "soft hold" flag: NULL = no open
--       withdrawal request, UTC ISO8601 = moment the first pending ticket was
--       filed. Kept on the profile row (instead of a subquery over 016) so the
--       report page SSR, by-subject resolution and the dialect-free candidate
--       search can all see the hold without an extra query. Cleared again when
--       a ticket is rejected; approval deletes the profile outright, so no
--       status column is needed here. No CHECK (would force a table rebuild on
--       SQLite); value domain is guaranteed by the repository methods.

ALTER TABLE profiles ADD COLUMN removal_requested_at TEXT;

-- DOWN BEGIN
ALTER TABLE profiles DROP COLUMN removal_requested_at;
-- DOWN END
