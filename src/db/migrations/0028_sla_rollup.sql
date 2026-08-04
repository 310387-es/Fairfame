-- Rolling up a backlog of lapsed deadlines (P2-T7, follow-up).
--
-- Two changes, for one problem: the first sweep against an existing
-- installation found fifty-one unanswered, overdue reviews and would have put
-- fifty-one urgent items into one person's feed. That is accurate and useless —
-- the fastest way to teach somebody to mute the product is to be right at them
-- fifty-one times at once.
--
--   `sla_rollup` is the alert that says "23 items are overdue" instead.
--
--   `reviews.sla_alerted_at` is what makes it work. Until now "have we already
--   reported this?" was answered by looking for a notification row naming the
--   review — which a rollup does not have. Stamping the review instead means
--   one rollup can account for twenty reviews, and none of them come back on
--   the next sweep. It also lets the sweep *claim* rows, so two workers running
--   at once cannot both report the same backlog.

ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'sla_rollup';--> statement-breakpoint

ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "sla_alerted_at" timestamp with time zone;--> statement-breakpoint

-- The sweep's own query: unreported breaches, oldest deadline first. Partial,
-- because a reported one never needs looking at again and the reported ones
-- become almost the whole table.
CREATE INDEX IF NOT EXISTS "reviews_sla_unalerted_idx"
  ON "reviews" ("organization_id", "sla_due_at")
  WHERE "sla_alerted_at" IS NULL AND "sla_due_at" IS NOT NULL;
