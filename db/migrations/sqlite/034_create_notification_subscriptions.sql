-- Migration 034: create notification_subscriptions for touch channels
-- File: 034_create_notification_subscriptions.sql
-- Date: 2026-10-10 11:00
-- Dialect: SQLite
-- Depends on: 033
-- Ref: docs/design-notification-channels-20261010.md (decision #25)
-- Note: SQLite dialect. One row per account per channel endpoint; the row's
--       existence IS the opt-in (disabling deletes the row). channel is
--       'email_digest' or 'web_push'; endpoint is the push endpoint URL or the
--       destination email address; keys_json holds {p256dh, auth} for web_push
--       and stays NULL for email_digest. last_sent_at backs the email digest
--       window ("new pending candidates since the last sent digest") and is
--       observational only for web_push (pushed per match, no window).

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (account_id, channel, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_channel
  ON notification_subscriptions (channel, enabled);

-- DOWN BEGIN
DROP TABLE IF EXISTS notification_subscriptions;
-- DOWN END
