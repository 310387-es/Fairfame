-- Trigram indexes for the command palette's substring search.
--
-- The palette matches with ILIKE '%term%'. A leading wildcard cannot use a
-- btree index, so without these every keystroke is a sequential scan over the
-- organization's whole review history — fine at the few hundred rows a seeded
-- dev database holds, and a growing latency bill for a real multi-location
-- tenant. `pg_trgm` is what makes a leading-wildcard match indexable.
--
-- GIN rather than GiST: this is a read-heavy, write-once-per-review table, and
-- GIN answers containment faster at the cost of slower updates we do not make.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "reviews_text_trgm_idx" ON "reviews" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reviews_author_name_trgm_idx" ON "reviews" USING gin ("author_name" gin_trgm_ops);
