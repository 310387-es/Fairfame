-- Competitor benchmarking, framework only (P3-T6,
-- docs/19-phase-3-build-plan.md).
--
-- **One table, and deliberately not two.** The obvious second one is
-- `competitor_snapshots` — a rating and a review count captured over time, so
-- the benchmark can show a trend. It is not here, because the only source that
-- can fill it today is a fixture, and **invented rows written into a customer's
-- database outlive the flag that produced them**. A year from now nobody
-- remembers which figures were real; the `iys_uploaded_via` column exists in
-- this schema for exactly that lesson.
--
-- So the competitors a business names are stored (that is real configuration
-- they typed), and their numbers are fetched from the source at read time. When
-- a real adapter lands at go-live, a snapshot table can land with it — and
-- every row in it will have come from somewhere.

CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	-- Null benchmarks the organization as a whole. A chain comparing itself to
	-- a rival across town does it per branch; a single-site business does not
	-- want to name a location to name a competitor.
	"location_id" uuid,
	-- What the business calls them. Their own words, shown as typed.
	"name" text NOT NULL,
	-- Which platform the listing is on. Free-form for the same reason
	-- `reviews.source` is: the set grows with each connector, and a widget or a
	-- benchmark written today must not break when a new one lands.
	"provider" text NOT NULL DEFAULT 'google',
	-- How the provider identifies the listing — a place id, a page handle, a
	-- URL. Opaque to us and never parsed here; the adapter that fetches it is
	-- the only thing that knows what shape it is.
	"external_ref" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Naming the same listing twice is a duplicate row in a comparison table,
	-- not a second competitor.
	CONSTRAINT "competitors_org_provider_ref_key"
	  UNIQUE NULLS NOT DISTINCT ("organization_id", "location_id", "provider", "external_ref")
);
--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitors_organization_id_idx" ON "competitors" USING btree ("organization_id");--> statement-breakpoint

-- Row-Level Security, on the same model as every tenant table since 0001.
ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.competitors FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.competitors
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitors TO fairfame_app;
