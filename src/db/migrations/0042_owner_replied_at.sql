-- One definition of "answered" (W1.2, docs/remediation-plan.md).
--
-- A review can be answered two ways: we post a reply, or the business answers
-- on the platform itself. The product only ever counted the first, except for
-- one read-time sniff at `raw_payload->'ownerReply'` that fed a badge and
-- nothing else. So a review the owner had already answered in Google Business
-- Profile showed "answered on Google" *and* counted as unanswered, *and* went
-- overdue, *and* sorted to the top of triage. That is the audit's fake overdue
-- count.
--
-- The sniff was wrong on its own terms too: Google writes `reviewReply`, not
-- `ownerReply`, so it only ever matched mock payloads and would have gone on
-- being wrong once real traffic arrived.
--
-- This column is the normalised fact. Each connector writes it from its own
-- payload shape at ingest; `src/inbox/answered.ts` is the only reader.
ALTER TABLE "reviews" ADD COLUMN "owner_replied_at" timestamp with time zone;--> statement-breakpoint

-- Backfill from what is already in `raw_payload`, as three explicit passes so
-- each payload shape is auditable on its own. Most specific first; every pass
-- is guarded on `owner_replied_at IS NULL`, so an earlier, better answer is
-- never overwritten by a later, vaguer one.
--
-- `pg_input_is_valid` (pg16+) is what keeps one malformed string inside a jsonb
-- blob from failing the migration and taking the deploy with it. A row whose
-- timestamp will not parse is left null — unanswered, which is where it
-- already was.

-- The mock and fixture connectors.
UPDATE "reviews"
   SET "owner_replied_at" = ("raw_payload"->'ownerReply'->>'repliedAt')::timestamptz
 WHERE "owner_replied_at" IS NULL
   AND "raw_payload"->'ownerReply'->>'repliedAt' IS NOT NULL
   AND pg_input_is_valid("raw_payload"->'ownerReply'->>'repliedAt', 'timestamptz');--> statement-breakpoint

-- Google, when it dates the reply.
UPDATE "reviews"
   SET "owner_replied_at" = ("raw_payload"->'reviewReply'->>'updateTime')::timestamptz
 WHERE "owner_replied_at" IS NULL
   AND "raw_payload"->'reviewReply'->>'updateTime' IS NOT NULL
   AND pg_input_is_valid("raw_payload"->'reviewReply'->>'updateTime', 'timestamptz');--> statement-breakpoint

-- Google, when it does not. The review's own last-modified time moves when a
-- reply is added, so it is the closest honest answer to "when" — and it is
-- never consulted unless `reviewReply` is actually present, so an unanswered
-- review cannot pick up a timestamp here.
UPDATE "reviews"
   SET "owner_replied_at" = ("raw_payload"->>'updateTime')::timestamptz
 WHERE "owner_replied_at" IS NULL
   AND "raw_payload" ? 'reviewReply'
   AND "raw_payload"->>'updateTime' IS NOT NULL
   AND pg_input_is_valid("raw_payload"->>'updateTime', 'timestamptz');
