-- Staff mentions, extracted from review text (P3-T4,
-- docs/19-phase-3-build-plan.md).
--
-- The Insights page asks "are we improving, where, and driven by what", and one
-- honest answer a service business gives is *who*. Customers name people —
-- "Ayşe was wonderful", "the manager never came back" — and that is a signal no
-- rating column carries.
--
-- **This column holds personal data about employees, and it is worth being
-- explicit about that.** The names are ones customers wrote in reviews that are
-- already public, so nothing private is being created; but a business is now
-- holding a structured, queryable record of what was said about a named member
-- of staff, which is a different thing from a paragraph of prose. Two
-- consequences, both enforced elsewhere and recorded here so the next reader
-- meets them:
--
--   1. It rides on `reviews`, so KVKK/GDPR export and delete already reach it —
--      the row is cascade-deleted with the review it describes.
--   2. The product surfaces it as *what customers said*, never as a computed
--      performance rating. An automated score about a named individual, used
--      for employment decisions, is a category of processing this product has
--      no basis for and does not do.
--
-- Empty for every existing row. `analyze_review@2` is the first prompt that
-- extracts names, and the batch runner's staleness check is by content hash, so
-- prose that has not changed is not re-analysed just because the prompt moved.
-- Backfilling is a deliberate operator action (`pnpm ai:analyze --recompute`),
-- because re-analysing a corpus costs real money — and the Insights page says
-- how many rows predate the change rather than showing their absence as "no one
-- was mentioned".
ALTER TABLE "review_insights"
  ADD COLUMN "staff" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint

-- Per-name lookups over an array column, for the staff panel's aggregate.
CREATE INDEX "review_insights_staff_idx"
  ON "review_insights" USING gin ("staff");
