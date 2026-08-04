-- Manual tags on a review (P2-T6, docs/17-phase-2-build-plan.md).
--
-- Bulk actions include "tag", and there was nowhere to put one. The obvious
-- home — `review_insights.topics` — is the wrong one: that column is what the
-- *model* said, it is the evidence a re-analysis is measured against, and a
-- human writing into it would falsify the record and then lose their tag the
-- next time the review was re-analysed.
--
-- So a join table, pointing at `tags` (the organization's curated vocabulary)
-- rather than holding free text. Tagging fifty reviews "servis" and fifty more
-- "Servis " must not produce two themes, and renaming a theme has to reach
-- every review already carrying it.

CREATE TABLE "review_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"tagged_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_tags_review_tag_key" UNIQUE("review_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "review_tags" ADD CONSTRAINT "review_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tags" ADD CONSTRAINT "review_tags_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tags" ADD CONSTRAINT "review_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tags" ADD CONSTRAINT "review_tags_tagged_by_user_id_users_id_fk" FOREIGN KEY ("tagged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_tags_org_tag_idx" ON "review_tags" USING btree ("organization_id","tag_id");--> statement-breakpoint
CREATE INDEX "review_tags_review_idx" ON "review_tags" USING btree ("review_id");--> statement-breakpoint

-- Row-Level Security, on the same model as every tenant table since 0001.
ALTER TABLE public.review_tags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.review_tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.review_tags
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_tags TO revira_app;