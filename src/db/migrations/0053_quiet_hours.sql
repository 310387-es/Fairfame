-- Notification quiet hours (W5-15, item 15 on the Wave 5 backlog).
--
-- The complaint behind it: an owner with instant email on gets a phone that
-- buzzes at 03:40 because somebody left a review, and the fix available today
-- is to turn instant email off — which loses the feature rather than the
-- interruption.
--
-- ## `quiet_from` / `quiet_to`
--
-- Minutes since local midnight, both nullable, and either one missing means no
-- quiet hours. Minutes rather than `time` because every operation is arithmetic
-- and the window may **wrap midnight**: 22:00–08:00 is the only shape anybody
-- actually wants, and a `from < to` check constraint would refuse it. The
-- wrapping is interpreted in exactly one place,
-- `src/notifications/quiet-hours.ts`.
--
-- ## `notifications.send_after`
--
-- The alternative was a new `email_status`, and it would have rippled: every
-- query that means "not sent yet" would have had to learn a second word for it,
-- and rollups, retries and the digest backlog all read that column. A nullable
-- timestamp composes with all of them — the sender gains one predicate and
-- nothing else changes.
--
-- Written from the recipient's window at the moment the row is created rather
-- than consulted at send time, so somebody changing their quiet hours does not
-- retroactively silence or release alerts that were already decided.
--
-- **It holds the email, never the in-app row.** Quiet hours are about a phone
-- at night, not about hiding what happened: the feed entry is written
-- immediately, and what waits is the thing that would have woken somebody.
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_from" integer;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_to" integer;--> statement-breakpoint

ALTER TABLE "notifications" ADD COLUMN "send_after" timestamptz;--> statement-breakpoint

-- The sender's predicate is `email_status = 'pending' AND (send_after IS NULL
-- OR send_after <= now())`. Partial on the status, because the pending set is a
-- tiny fraction of the table and everything else is history.
CREATE INDEX "notifications_send_after_idx"
  ON "notifications" ("send_after")
  WHERE "email_status" = 'pending';
