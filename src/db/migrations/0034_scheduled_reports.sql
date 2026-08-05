-- Scheduled PDF reports (P3-T5, docs/19-phase-3-build-plan.md).
--
-- Two tables, and the split is the same one `digest_deliveries` already makes:
-- what somebody asked for, and what was actually sent. Keeping them apart is
-- what makes the sweep safe to re-run — "already sent" is a row, never an
-- assumption about how often a job fired.

-- ---------------------------------------------------------------------------
-- 1. What was asked for
-- ---------------------------------------------------------------------------
CREATE TYPE "report_cadence" AS ENUM ('weekly', 'monthly');--> statement-breakpoint

CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	-- Who receives it. A schedule belongs to a *person*, not to an
	-- organization, for the same reason notification preferences do: "email me
	-- this every Monday" is a personal arrangement, and a shared one would need
	-- recipient management the product cannot offer until invitations exist.
	"user_id" uuid NOT NULL,
	-- Null means every branch the recipient may see, resolved at send time
	-- rather than frozen here — a member's location scope can change, and a
	-- report that kept mailing a branch they lost access to would be a leak.
	"location_id" uuid,
	"cadence" "report_cadence" NOT NULL DEFAULT 'weekly',
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- One schedule per person per scope. Two would mail the same PDF twice.
	CONSTRAINT "report_schedules_org_user_location_key"
	  UNIQUE NULLS NOT DISTINCT ("organization_id", "user_id", "location_id")
);
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_schedules_organization_id_idx" ON "report_schedules" USING btree ("organization_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. What was sent
-- ---------------------------------------------------------------------------
--
-- The ledger, keyed by the period it covered rather than by a timestamp. That
-- is what makes the sweep idempotent: a job that runs twice on Monday morning
-- finds the row for last week's period and does nothing, and one that runs for
-- the first time on Wednesday still sends Monday's report exactly once.
CREATE TABLE "report_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	-- The window's start, UTC, normalised to the cadence's boundary.
	"period_start" timestamp with time zone NOT NULL,
	"status" "digest_delivery_status" NOT NULL,
	-- The transport's reason, kept for the failed rows a human has to explain.
	"error" text,
	-- Null on a failed row: nothing left.
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_deliveries_schedule_period_key" UNIQUE("schedule_id", "period_start")
);
--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_schedule_id_report_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_deliveries_organization_id_idx" ON "report_deliveries" USING btree ("organization_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-Level Security, on the same model as every tenant table since 0001.
-- ---------------------------------------------------------------------------
ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.report_schedules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.report_schedules
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.report_schedules TO revira_app;--> statement-breakpoint

ALTER TABLE public.report_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.report_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.report_deliveries
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.report_deliveries TO revira_app;
