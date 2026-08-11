-- The digest delivery ledger (D1, docs/14-digest-surfaces.md).
--
-- The digest sweep is deliberately re-runnable — it fires hourly so a missed
-- window is retried within the hour rather than lost for a week — which means
-- "has this person already been sent this briefing?" cannot be inferred from
-- how often the job ran. It has to be written down.
--
-- One row per (digest, recipient, channel), so a partial failure is
-- expressible: three delivered and two bounced is a real state, and a single
-- flag on `digests` could only say "yes" or "no" for all five.

CREATE TYPE "public"."digest_channel" AS ENUM('email', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."digest_delivery_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "digest_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "digest_channel" NOT NULL,
	"status" "digest_delivery_status" NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_deliveries_digest_user_channel_key" UNIQUE("digest_id","user_id","channel")
);
--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_deliveries" ADD CONSTRAINT "digest_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_deliveries_digest_idx" ON "digest_deliveries" USING btree ("digest_id","channel");--> statement-breakpoint
CREATE INDEX "digest_deliveries_org_created_idx" ON "digest_deliveries" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- Row-Level Security, on the same model as every other tenant table: ENABLE +
-- FORCE with a policy keyed on the transaction-local `app.current_org` GUC.
--
-- A delivery row names a person and the briefing they were sent. That is less
-- concentrated than `digests` itself, but it is still "who at this business
-- reads what", and it must not be visible across the tenant boundary.
ALTER TABLE public.digest_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.digest_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.digest_deliveries
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.digest_deliveries TO fairfame_app;