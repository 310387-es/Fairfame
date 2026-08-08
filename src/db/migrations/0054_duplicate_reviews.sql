-- Cross-source duplicate detection (W5-7, item 7 on the Wave 5 backlog).
--
-- A customer who has a bad afternoon frequently says so twice: on Google, and
-- on the form the business linked from the same page. Both arrive, both get
-- analysed, and somebody answers the same complaint twice.
--
-- ## What this column is, and what it is not
--
-- It records that a review is the *second* copy of an earlier one. Nothing that
-- computes a number reads it, deliberately: the average rating, the review
-- count, the sentiment split and the digest all still see both rows.
--
-- Dropping one from our average would make our number disagree with the one on
-- the business's Google listing — and the listing is the number they are judged
-- by. What an owner actually needs is not to answer the same person twice, and
-- that is a badge and a filter. Whether a *briefing* should count that
-- customer's themes once is a real question and a separate one; this link is
-- what a later change would read.
--
-- ## The shape
--
-- A self-reference rather than a `duplicate_groups` table. There are exactly
-- two rows in the overwhelming majority of cases, the relationship is
-- directional (the older one is the original — arrival order is the only rule
-- two scans cannot disagree about), and a group table would need a row, a
-- membership and a nominated primary to express something one nullable column
-- already says.
--
-- ON DELETE SET NULL: a KVKK erasure of the original must leave the other
-- review standing on its own rather than pointing at nothing.
--
-- Not a foreign key to `reviews(id)` with a composite tenant check, because
-- `reviews.id` is already globally unique and RLS scopes every read — but the
-- scan only ever compares within one organization *and* one location, which is
-- the constraint that actually matters and is enforced in the query.
ALTER TABLE "reviews"
  ADD COLUMN "duplicate_of_id" uuid REFERENCES "reviews"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Partial: almost every row is null, and the two questions are "is this one a
-- duplicate" and "what duplicates this one".
CREATE INDEX "reviews_duplicate_of_idx"
  ON "reviews" ("duplicate_of_id")
  WHERE "duplicate_of_id" IS NOT NULL;
