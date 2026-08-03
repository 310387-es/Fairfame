-- Diacritic- and case-insensitive search, for Turkish.
--
-- Plain ILIKE is broken in this market, and quietly:
--
--   lower('İstanbul') = 'istanbul'  →  false
--   lower('HAVASIZ')  = 'havasız'   →  false
--
-- Postgres lowercases with the database collation, which has no idea that
-- Turkish has a dotted and a dotless I. `İ` lowercases to `i` plus a combining
-- dot, and `I` lowercases to `i` rather than `ı` — so a customer searching for
-- "istanbul" would never find "İstanbul", and neither would they find
-- "havasız" by typing "havasiz". Turkish speakers type ASCII constantly, on
-- phone keyboards especially, so this is the common case rather than the edge.
--
-- `unaccent` folds both alphabets onto ASCII, which makes the comparison work
-- in both directions. Order matters: unaccent first, then lower. The other way
-- round, `lower('İ')` has already become two codepoints and unaccent no longer
-- recognises it.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint

-- `unaccent(text)` is only STABLE, because it depends on a dictionary that
-- could in principle be changed — so Postgres refuses to index it. This wrapper
-- pins the dictionary by name, which makes it safe to declare IMMUTABLE and
-- therefore indexable. Without it the folded search would be a sequential scan.
CREATE OR REPLACE FUNCTION "immutable_unaccent"(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;--> statement-breakpoint

-- The plain trigram indexes from 0021 no longer match the query expression.
DROP INDEX IF EXISTS "reviews_text_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_author_name_trgm_idx";--> statement-breakpoint

CREATE INDEX "reviews_text_folded_trgm_idx"
  ON "reviews" USING gin (lower("immutable_unaccent"("text")) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reviews_author_name_folded_trgm_idx"
  ON "reviews" USING gin (lower("immutable_unaccent"("author_name")) gin_trgm_ops);
