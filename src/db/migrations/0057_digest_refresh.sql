-- Refreshing a digest without being able to destroy it (A22-A1).
--
-- Regeneration used `status` for two different jobs: "a worker is composing
-- this" and "this is what the owner may read". So pressing "Compose this week"
-- on a ready briefing moved it to `pending` before the first model call, and a
-- failure moved it to `failed` — while the good payload sat untouched in the
-- column, invisible to every reader, all of which filter on `ready`. The
-- owner's weekly plan disappeared because a refresh of it did not work.
--
-- These two columns give the refresh its own state, so the published columns
-- (`status`, `payload`, `pulse_score`, `generated_at`) are written exactly
-- once, on success, in the transaction that also replaces the actions — the
-- "swap on success" the fix plan asks for, without a second row.
--
-- `refresh_started_at` is the claim. Conditional on being null or stale, so two
-- workers cannot compose the same week twice; a crashed worker's claim ages out
-- rather than wedging the week forever.
ALTER TABLE "digests" ADD COLUMN "refresh_started_at" timestamptz;--> statement-breakpoint

-- `refresh_error` is what the screen renders as "couldn't refresh, retrying".
-- Separate from `last_error`, which describes how the row itself came to be
-- `failed`: a briefing can be perfectly readable *and* have a stale refresh
-- behind it, and one column cannot say both.
ALTER TABLE "digests" ADD COLUMN "refresh_error" text;--> statement-breakpoint

-- Give back the briefings the old behaviour hid.
--
-- Every account that pressed the button and lost a week still has the week: a
-- payload is written only next to `generated_at`, and only by a composition
-- that succeeded, so a `failed` row carrying both is a published briefing with
-- a failed *refresh* written over its status. That is precisely the state these
-- two new columns exist to express, so the rows can simply be restated in it
-- rather than left as the only casualties of the bug.
UPDATE "digests"
   SET "status" = 'ready',
       "refresh_error" = "last_error",
       "last_error" = NULL
 WHERE "status" = 'failed'
   AND "payload" IS NOT NULL
   AND "generated_at" IS NOT NULL;
