-- A backfill is not news (W1.3, docs/remediation-plan.md).
--
-- Connecting Google to a fresh account produced 217 unread notifications, one
-- per review the business had ever received. `pendingReviews` bounded itself
-- with `reviews.created_at > now() - interval '7 days'` — but on a first sync
-- every row is *created* now, however long ago the customer wrote it, so the
-- window let the whole history through.
--
-- Two rules close it, and this column is what makes the first one askable:
--
--   1. anything that arrived in a connection's **first** sync is history;
--   2. anything posted before the connection existed is history too.
--
-- Rule 2 alone very nearly suffices, and it is the one that catches the audit's
-- case. Rule 1 exists for the gap it leaves, which this product creates on
-- purpose: a Google connection is made in `pending` and only syncs once someone
-- maps it to a business location, which can be days later. Reviews written in
-- between are newer than the connection and would still arrive in one heap.
--
-- `last_synced_at` cannot answer rule 1 — it moves on every sync, so by the
-- time the notification sweep runs, the first sync is indistinguishable from
-- the fiftieth. Hence a column that is written once.
ALTER TABLE "connections" ADD COLUMN "first_synced_at" timestamp with time zone;--> statement-breakpoint

-- Existing connections: treat the first sync as having happened when the
-- connection was made, which is what actually happens — a connection syncs
-- within minutes of being created.
--
-- Deliberately *not* `last_synced_at`. That would mark everything ingested up
-- to now as backfill and silence alerts about reviews that genuinely arrived
-- this week. Suppressing a real review is the worse error of the two, and the
-- one nobody would ever notice.
UPDATE "connections"
   SET "first_synced_at" = "created_at"
 WHERE "first_synced_at" IS NULL
   AND "last_synced_at" IS NOT NULL;
