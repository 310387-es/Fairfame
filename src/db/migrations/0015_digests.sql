CREATE TYPE "public"."digest_action_status" AS ENUM('open', 'done', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."digest_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "digest_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"digest_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" "digest_action_status" DEFAULT 'open' NOT NULL,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_actions_digest_position_key" UNIQUE("digest_id","position"),
	CONSTRAINT "digest_actions_position_range" CHECK ("digest_actions"."position" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "digest_status" DEFAULT 'pending' NOT NULL,
	"pulse_score" real,
	"pulse_delta" real,
	"review_count" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"locale" text,
	"prompt_id" text,
	"model" text,
	"last_error" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_location_period_key" UNIQUE("location_id","period_start"),
	CONSTRAINT "digests_pulse_range" CHECK ("digests"."pulse_score" is null or "digests"."pulse_score" between 0 and 100),
	CONSTRAINT "digests_period_order" CHECK ("digests"."period_end" > "digests"."period_start")
);
--> statement-breakpoint
ALTER TABLE "digest_actions" ADD CONSTRAINT "digest_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_actions" ADD CONSTRAINT "digest_actions_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_actions" ADD CONSTRAINT "digest_actions_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_actions_org_status_idx" ON "digest_actions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "digests_org_period_idx" ON "digests" USING btree ("organization_id","period_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "digests_location_period_idx" ON "digests" USING btree ("location_id","period_start" DESC NULLS LAST);