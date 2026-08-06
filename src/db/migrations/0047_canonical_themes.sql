-- Canonical themes, beside the free-text tags (W3.2, docs/remediation-plan.md).
--
-- `review_insights.topics` asked the model for tags "in the review's own
-- language", so one complaint arrived as `bekleme süresi` from a Turkish
-- customer and `waiting time` from an English one. The product treated them as
-- two themes: two filter chips, two chart lines, two digest clusters, and no
-- way to compare a café in Kadıköy with one anywhere else.
--
-- **Two columns, two jobs.** `themes` is a closed vocabulary — what gets
-- charted, filtered, compared and translated. `topics` keeps the long tail in
-- the customer's own words, because `mercimek çorbası` is not a theme, it is
-- evidence, and it is what makes a digest worth reading.
--
-- Nullable with no backfill, deliberately. Every existing row was analysed by
-- `analyze_review@2`, which was never asked for a canonical theme; inventing
-- one by keyword-matching Turkish tags would put guesses in the column the
-- product is about to trust for trends. Rows fill in as they are re-analysed
-- (`pnpm ai:analyze --recompute`), and until then a screen shows what it has —
-- `src/analytics/*` already distinguishes "none" from "not analysed".
ALTER TABLE "review_insights" ADD COLUMN "themes" text[];--> statement-breakpoint

-- The one index the new column needs: every reader asks "which reviews carry
-- this theme", which is a containment test.
CREATE INDEX "review_insights_themes_idx" ON "review_insights" USING gin ("themes");--> statement-breakpoint

-- `locations.category` was free text and therefore drove nothing. It picks the
-- theme vocabulary now, so it has to be one of a known set — checked in the
-- application (`src/reviews/taxonomy.ts`) rather than as a database enum, for
-- the reason `digest_actions.lever` is text: the list will move as the product
-- learns which verticals it actually serves, and a database enum makes every
-- revision a migration and a deploy.
COMMENT ON COLUMN "locations"."category" IS
  'One of VERTICALS in src/reviews/taxonomy.ts. Drives the theme vocabulary.';
