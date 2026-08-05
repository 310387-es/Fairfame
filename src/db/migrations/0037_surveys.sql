-- NPS / CSAT surveys (P4-T2, docs/20-phase-4-build-plan.md).
--
-- Two tables, shaped deliberately like `campaigns` + `review_requests`, because
-- they are the same thing pointed at a different question: a definition that
-- fixes everything *before* anybody answers, and one row per person carrying
-- the funnel from ask to answer.
--
-- **The compliance rule is in the shape, not in a comment.** `docs/20` forbids
-- review-gating: routing unhappy customers away from a public review while
-- steering happy ones to Google. So a survey has no review destination of its
-- own — it names a **collection campaign** (`review_campaign_id`), and the
-- destination is resolved by `src/collect/routing.ts`, which takes a campaign
-- and nothing else and has never been able to see a rating. A survey therefore
-- *inherits* the guarantee rather than re-implementing it, and adding
-- score-based routing would mean adding a parameter to a function three
-- unrelated call sites already depend on not having one.

CREATE TYPE "survey_type" AS ENUM('nps', 'csat');--> statement-breakpoint
CREATE TYPE "survey_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
-- The same funnel `review_request_status` records, plus the terminal state that
-- is specific to a survey: an answer.
CREATE TYPE "survey_response_status" AS ENUM('pending', 'sent', 'opened', 'answered', 'failed');--> statement-breakpoint

CREATE TABLE "surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	-- NPS (0–10) or CSAT (1–5). The scale is a property of the type and is not
	-- stored: a stored scale that disagreed with the type would make every
	-- historical score unreadable. src/surveys/scoring.ts owns it.
	"type" "survey_type" NOT NULL,
	"status" "survey_status" DEFAULT 'draft' NOT NULL,
	-- Language of the hosted page and the invitation, exactly as campaigns do
	-- it: a customer should not be emailed in English because an admin was
	-- viewing the dashboard in English.
	"locale" text,
	-- Public short code. Globally unique: it is a URL, not a tenant column.
	"slug" text NOT NULL,
	-- The question, if the business wrote its own. Null uses the template.
	"question" text,
	-- Whether a detractor is offered a private "tell us more" box after
	-- answering. **This is the only thing a score is allowed to decide.**
	"follow_up_enabled" boolean DEFAULT true NOT NULL,
	"follow_up_prompt" text,
	-- Where a public review is invited *after* answering — for everybody, at
	-- every score, or for nobody. Null means the survey never mentions reviews.
	-- Deliberately a campaign rather than a URL, so `resolveDestination` stays
	-- the only thing that decides where a review request points.
	"review_campaign_id" uuid,
	-- Per-survey copy overrides for the invitation: subject, heading, body.
	"message" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "surveys_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_review_campaign_id_campaigns_id_fk" FOREIGN KEY ("review_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "surveys_organization_id_idx" ON "surveys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "surveys_location_id_idx" ON "surveys" USING btree ("location_id");--> statement-breakpoint

ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.surveys FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.surveys
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surveys TO revira_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- One person's participation, from ask to answer
-- ---------------------------------------------------------------------------
--
-- One table rather than "sends" plus "answers", for the reason `review_requests`
-- is one table: "we asked 200 people and 40 answered" is the question everybody
-- asks first, and across two tables it needs a join and a decision about which
-- side is authoritative. A walk-in answer — somebody scanning a QR code with no
-- invitation behind it — is a row created at answer time with `sent_at` null,
-- exactly as `recordWalkInRequest` does for reviews.
CREATE TABLE "survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	-- Null for a walk-in: nobody was asked, and nobody handed over an address.
	"contact_id" uuid,
	"channel" "campaign_channel" NOT NULL,
	"status" "survey_response_status" DEFAULT 'pending' NOT NULL,
	-- The secret in the link. Anyone holding it can answer as the person we
	-- asked, so it is CSPRNG-generated and unique across tenants — it appears in
	-- a URL before any tenant context exists.
	"token" text NOT NULL,
	"sent_at" timestamp with time zone,
	-- First touch only: a second visit does not move the funnel backwards.
	"opened_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	-- The raw answer, on the type's own scale. Stored raw rather than
	-- normalised: a 7 means different things on the two scales and converting
	-- at write time would destroy the only number the customer actually gave.
	"score" integer,
	-- What they wrote alongside the score. Public-ish in the sense that it is
	-- what the survey asked for.
	"comment" text,
	-- The **private** follow-up, offered to a detractor after answering. Kept
	-- apart from `comment` because it was given under a different promise: it
	-- answers "what went wrong, and may we put it right", not "what do you think
	-- of us". It is never a candidate for display anywhere public.
	"follow_up_comment" text,
	-- The platform's id for the message we sent — a wamid, an SMS reference.
	"external_id" text,
	"failure_reason" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey_responses_token_unique" UNIQUE("token"),
	-- 0–10 covers both scales; which values are legal for *this* survey is a
	-- question about its type, and src/surveys/scoring.ts is the one place that
	-- knows. The constraint is the floor, not the rule.
	CONSTRAINT "survey_responses_score_range" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 10),
	-- A row that claims to be answered must carry an answer, and vice versa.
	-- Without this an interrupted write could leave "answered" with no score,
	-- which would silently drag every average down by counting a non-answer.
	CONSTRAINT "survey_responses_answered_has_score"
	  CHECK (("answered_at" IS NULL) = ("score" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "survey_responses_organization_id_idx" ON "survey_responses" USING btree ("organization_id");--> statement-breakpoint
-- The results screen: one survey, newest answer first.
CREATE INDEX "survey_responses_survey_answered_idx" ON "survey_responses" USING btree ("survey_id","answered_at" DESC);--> statement-breakpoint
-- Scoring across a date range and a set of locations, for Insights. Partial:
-- an unanswered ask has no score to average, and the pending rows become the
-- bulk of the table.
CREATE INDEX "survey_responses_org_answered_idx"
  ON "survey_responses" USING btree ("organization_id","answered_at" DESC)
  WHERE "answered_at" IS NOT NULL;--> statement-breakpoint
-- The contact timeline, and the location-scope check in src/contacts/scope.ts.
CREATE INDEX "survey_responses_contact_idx" ON "survey_responses" USING btree ("contact_id");--> statement-breakpoint

ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.survey_responses FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.survey_responses
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.survey_responses TO revira_app;
