-- Whether a notification has reached a device (W5-9).
--
-- Split from 0055 only because that migration had already been applied when
-- this column was needed; they are one change conceptually.
--
-- A timestamp rather than a status enum like `email_status`. Push has no
-- "deferred" and no "skipped" to distinguish: either a device took it, or there
-- was nothing to send to — and the second is a fact about the *person*, not
-- about the notification, so recording it on the row would be recording it in
-- the wrong place and once per notification instead of once per user.
--
-- The sender's predicate is `pushed_at IS NULL AND read_at IS NULL AND
-- (send_after IS NULL OR send_after <= now())` — the same `send_after` clause
-- the email sender applies, which is how quiet hours (W5-15) hold here without
-- being written twice.
ALTER TABLE "notifications" ADD COLUMN "pushed_at" timestamptz;--> statement-breakpoint

-- The drain: unpushed, unread, recent. Partial, because that set is a
-- vanishing fraction of the table and everything else is history.
CREATE INDEX "notifications_push_pending_idx"
  ON "notifications" ("organization_id", "created_at")
  WHERE "pushed_at" IS NULL AND "read_at" IS NULL;
