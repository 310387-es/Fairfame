CREATE TYPE "public"."reply_status" AS ENUM('draft', 'approved', 'posted', 'failed');--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"author_user_id" uuid,
	"approved_by_user_id" uuid,
	"text" text NOT NULL,
	"status" "reply_status" DEFAULT 'draft' NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"original_text" text,
	"prompt_id" text,
	"model" text,
	"external_id" text,
	"last_error" text,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "brand_tone" text;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "replies_one_live_per_review" ON "replies" USING btree ("review_id") WHERE status <> 'failed';--> statement-breakpoint
CREATE INDEX "replies_organization_id_idx" ON "replies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "replies_org_status_idx" ON "replies" USING btree ("organization_id","status");