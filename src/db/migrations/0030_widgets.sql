-- Public showcase: widgets, and the per-review approval that gates them
-- (P3-T0, docs/19-phase-3-build-plan.md).
--
-- Two things land together because neither is safe alone. A `widgets` table
-- without an approval flag is a public endpoint that serves whatever happens to
-- be in `reviews` — including a first-party submission a customer typed into
-- our own form believing it went to the business, and a rant the business has
-- never seen. An approval flag without a widget has nothing to gate.

-- ---------------------------------------------------------------------------
-- 1. Per-review display approval
-- ---------------------------------------------------------------------------
--
-- A nullable timestamp, not a boolean: "when was this cleared, and by whom" is
-- the question anyone auditing a published quote will actually ask, and a
-- boolean answers neither. Null means not approved, which is where every
-- existing row starts — nobody has approved anything yet, and a backfill to
-- `true` would put a claim in the database that is simply false.
ALTER TABLE "reviews" ADD COLUMN "display_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "display_approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_display_approved_by_user_id_users_id_fk" FOREIGN KEY ("display_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- A direct message can never be published, and the database is where that is
-- settled rather than in whichever query happens to be reading.
--
-- A DM is private correspondence between one person and the business. It was
-- never public anywhere, it carries no `url` for the same reason (see the
-- Instagram ingest note in CLAUDE.md), and the sender had no way to know it
-- could end up on a marketing page. Every other item type is already public on
-- the platform it came from, or was submitted to a form that says where it
-- goes. So: a CHECK, not a WHERE clause someone can forget.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_dm_never_published"
  CHECK ("item_type" <> 'dm' OR "display_approved_at" IS NULL);--> statement-breakpoint

-- The public widget read: approved rows for one organization, newest first.
-- Partial, because approved rows are the small minority and the public query
-- never asks for the others.
CREATE INDEX "reviews_org_display_approved_idx"
  ON "reviews" USING btree ("organization_id", "location_id", "posted_at" DESC)
  WHERE "display_approved_at" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Widgets
-- ---------------------------------------------------------------------------
--
-- Shape from docs/03 §Data model (id, org_id, public_key, filters, style) plus
-- the `published` flag the Phase 3 plan asks for.
CREATE TABLE "widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	-- Null means every location in the organization. A chain wanting one widget
	-- per branch makes one widget per branch; a single-site business should not
	-- have to name its only location to get a widget.
	"location_id" uuid,
	"name" text NOT NULL,
	-- The lookup key, and the only thing the public endpoint is given. Globally
	-- unique because there is no tenant in scope at lookup time — the key *is*
	-- how the tenant is discovered. Long and CSPRNG-generated so the namespace
	-- cannot be walked: the key is not a secret (it sits in the customer's page
	-- source) but enumerating it must not be a way to discover other businesses.
	"public_key" text NOT NULL,
	-- Which reviews qualify: sources, minimum rating, item types, count.
	-- Validated by Zod on the way in and on the way out — see src/widgets/config.ts.
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- How it looks: layout, theme, locale, accent.
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- Off by default. Creating a widget in the builder must not be the same
	-- action as putting it on the internet.
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widgets_public_key_key" UNIQUE("public_key")
);
--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widgets_organization_id_idx" ON "widgets" USING btree ("organization_id");--> statement-breakpoint

-- Row-Level Security, on the same model as every tenant table since 0001.
--
-- The public endpoint still resolves the key through the owner connection —
-- there is no tenant context before the key names one — but everything it does
-- afterwards runs under RLS, and every in-app read and write of this table is
-- tenant-scoped like any other.
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.widgets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.widgets
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.widgets TO revira_app;
