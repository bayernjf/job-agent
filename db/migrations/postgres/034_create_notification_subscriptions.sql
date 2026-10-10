-- Migration 034: create notification_subscriptions for touch channels
-- File: 034_create_notification_subscriptions.sql
-- Date: 2026-10-10 11:00
-- Dialect: Postgres
-- Depends on: 033
-- Ref: docs/design-notification-channels-20261010.md (decision #25)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). One row per account per channel endpoint;
--       the row's existence IS the opt-in (disabling deletes the row).
--       channel is 'email_digest' or 'web_push'; endpoint is the push endpoint
--       URL or the destination email address; keys_json holds {p256dh, auth}
--       for web_push and stays NULL for email_digest. last_sent_at backs the
--       email digest window and is observational only for web_push.

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, channel, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_channel
  ON notification_subscriptions (channel, enabled);

COMMENT ON TABLE notification_subscriptions IS 'Touch-channel subscriptions (decision #25): one row per account per channel endpoint; row existence is the opt-in. email_digest rows carry the destination email in endpoint; web_push rows carry the push endpoint URL plus VAPID keys in keys_json. last_sent_at backs the digest window.';

-- DOWN BEGIN
DROP TABLE IF EXISTS notification_subscriptions;
-- DOWN END
