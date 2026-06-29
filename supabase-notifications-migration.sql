-- ══════════════════════════════════════════════════════════════════════
--  PETclub — Notification Inbox Migration
--  Run in Supabase SQL Editor → New Query
--  Safe to re-run: all statements use IF NOT EXISTS
-- ══════════════════════════════════════════════════════════════════════

-- Persistent notification inbox — one row per push sent
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  data        JSONB       DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fetch unread for a user (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- Fast unread count
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, read_at)
  WHERE read_at IS NULL;

-- Auto-purge: delete notifications older than 90 days to keep the table lean
-- Run this periodically via Cloud Scheduler or add to the hard-purge cron.
-- DELETE FROM notifications WHERE created_at < now() - interval '90 days';

-- RLS: users can only read/update their own notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users read own notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Users mark own notifications read"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role (backend) bypasses RLS — no policy needed for INSERT/DELETE from Node.js
