-- Team workflow on the inbox (P2-T1, docs/17-phase-2-build-plan.md).
--
-- Three things: the triage columns on `reviews`, a per-location SLA target, and
-- the two tables the filter bar will be built on. Additive throughout — no
-- column is dropped or narrowed, so this migration is safe to apply against a
-- database that is already serving the Phase 1 inbox.
--
-- The `status` backfill the plan asks for is the column default: adding a NOT
-- NULL column with DEFAULT 'open' writes 'open' into every existing row in the
-- same statement. It is stated here because "where is the backfill?" is the
-- first question a reviewer will have.

CREATE TYPE "public"."review_status" AS ENUM('open', 'in_progress', 'done', 'ignored');--> statement-breakpoint
CREATE TABLE "reply_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"language" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_templates_org_language_name_key" UNIQUE("organization_id","language","name")
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_org_owner_name_key" UNIQUE NULLS NOT DISTINCT("organization_id","owner_user_id","name")
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "sla_hours" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "status" "review_status" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "first_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_templates_organization_id_idx" ON "reply_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "reply_templates_tags_idx" ON "reply_templates" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "saved_views_org_owner_idx" ON "saved_views" USING btree ("organization_id","owner_user_id","position");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_org_location_status_idx" ON "reviews" USING btree ("organization_id","location_id","status","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_org_location_priority_idx" ON "reviews" USING btree ("organization_id","location_id","priority" DESC NULLS LAST,"posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_org_assignee_idx" ON "reviews" USING btree ("organization_id","assignee_user_id","posted_at" DESC NULLS LAST) WHERE assignee_user_id is not null;--> statement-breakpoint
CREATE INDEX "reviews_org_sla_due_idx" ON "reviews" USING btree ("organization_id","sla_due_at") WHERE sla_due_at is not null and status in ('open', 'in_progress');--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_sla_hours_positive" CHECK ("locations"."sla_hours" is null or "locations"."sla_hours" between 1 and 8760);--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_priority_range" CHECK ("reviews"."priority" is null or "reviews"."priority" between 0 and 100);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-Level Security for the two new tenant tables.
--
-- Same model as every table since migration 0001: ENABLE + FORCE, one policy
-- keyed on the transaction-local `app.current_org` GUC, so the tables read as
-- empty when no tenant context is set rather than relying on every query
-- remembering its WHERE clause.
--
-- `saved_views` deliberately gets the *organization* policy and not a
-- per-owner one. A private view is private by product rule, not by database
-- rule, and encoding "only the owner may read this" in a policy would break
-- the shared views (owner null) that the same table holds. Ownership is
-- filtered in src/inbox — the boundary that must not be crossed is the tenant.
-- ---------------------------------------------------------------------------

ALTER TABLE public.reply_templates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.reply_templates FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.reply_templates
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reply_templates TO revira_app;--> statement-breakpoint

ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.saved_views FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.saved_views
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_views TO revira_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill for rows that predate the workflow columns.
--
-- `sla_due_at` is plain arithmetic — posted_at plus the location's target, with
-- the same 24-hour fallback src/inbox/workflow.ts uses — so it is safe to do in
-- SQL. It does mark old unanswered reviews as breached, which is not a
-- cosmetic problem to be avoided: they *are* past a 24-hour response target,
-- and writing null instead would be a nicer-looking lie.
--
-- `first_response_at` comes from the earliest reply that was not rejected by
-- the platform, which is the closest thing to "when the team first answered"
-- that the existing data actually knows.
--
-- `priority` is deliberately NOT backfilled here. Its formula lives in
-- TypeScript (src/inbox/workflow.ts) and restating it in SQL would give the
-- product two definitions of the same number that drift apart on the first
-- change. Existing rows pick it up on the next analysis pass; new rows get it
-- at ingest.
-- ---------------------------------------------------------------------------

UPDATE public.reviews r
SET sla_due_at = r.posted_at + make_interval(hours => coalesce(l.sla_hours, 24))
FROM public.locations l
WHERE l.id = r.location_id
  AND r.posted_at IS NOT NULL
  AND r.sla_due_at IS NULL;
--> statement-breakpoint

UPDATE public.reviews r
SET first_response_at = f.first_at
FROM (
  SELECT review_id, min(coalesce(posted_at, approved_at, created_at)) AS first_at
  FROM public.replies
  WHERE status <> 'failed'
  GROUP BY review_id
) f
WHERE f.review_id = r.id
  AND r.first_response_at IS NULL;