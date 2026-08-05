-- Hosted public review pages, one per location (P3-T3,
-- docs/19-phase-3-build-plan.md).
--
-- The third public surface, after the widget API and the embed document — and
-- the first one meant to be *indexed*. A widget is a fragment inside somebody
-- else's page and is deliberately `noindex`; this is a page of its own, on our
-- domain, that a search engine is invited to keep.
--
-- That difference is why both columns exist rather than one. `public_slug` is
-- the address, and `public_page_published` is the consent — putting a
-- business's reviews on an indexable page under our brand is not something a
-- location should acquire by being created.

-- The address. Globally unique because it is a URL and there is no tenant in
-- scope when one arrives: the slug *is* how the tenant is discovered, exactly
-- as `widgets.public_key` and `campaigns.slug` already are.
--
-- Readable rather than random, unlike those two, because this one is meant to
-- be read — by a person deciding whether to click it in a search result, and by
-- a search engine weighing the words in it. That is also why it is assigned
-- once and then left alone: an indexed URL that changes when somebody edits a
-- location's name is a page that loses everything it had earned.
ALTER TABLE "locations" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_public_slug_key" UNIQUE("public_slug");--> statement-breakpoint

-- The consent. Off for every existing row and every new one.
--
-- Kept separate from the slug so that unpublishing is reversible without
-- destroying the address: a business that takes its page down for a month and
-- puts it back gets the same URL, and every link and search result that pointed
-- at it still works. Clearing the slug instead would make "unpublish" a
-- decision they could not undo.
ALTER TABLE "locations" ADD COLUMN "public_page_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- The sitemap's query: every published page, across all tenants, by slug.
--
-- Partial, because published pages are the small minority of locations and no
-- query here ever asks for the others. It is also the one index in the schema
-- that serves a deliberately cross-tenant read — see src/app/sitemap.ts for why
-- that is sound and what it is allowed to select.
CREATE INDEX "locations_public_page_idx"
  ON "locations" USING btree ("public_slug")
  WHERE "public_page_published" = true AND "public_slug" IS NOT NULL;
