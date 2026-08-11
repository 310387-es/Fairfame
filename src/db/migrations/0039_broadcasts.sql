-- Unified outbound campaigns (P4-T4, docs/20-phase-4-build-plan.md).
--
-- **Named `broadcasts`, not `campaigns`, and that is a deliberate deviation
-- from the plan's wording.** `docs/20` calls these "campaigns" — but the
-- product has used that word since P1b-T1 for a *collection strategy*: a
-- location, a destination, a hosted page and a QR code, surfaced on `/requests`
-- with the label "Campaign name". Two different things one screen apart, both
-- called a campaign, is worse than one table whose name does not match a
-- sentence in a build plan. A broadcast *references* a campaign for its
-- review-request kind; it does not replace it.
--
-- A broadcast is one send, of one thing, to one audience, now or later.

CREATE TYPE "broadcast_kind" AS ENUM('review_request', 'survey', 'message');--> statement-breakpoint
CREATE TYPE "broadcast_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled');--> statement-breakpoint
-- `refused` is its own state, distinct from `failed`. One means the compliance
-- gate said no before anything was attempted; the other means a platform
-- accepted the request and then could not deliver. Collapsing them would hide
-- the only one an operator can act on.
CREATE TYPE "broadcast_recipient_status" AS ENUM('pending', 'sent', 'refused', 'failed');--> statement-breakpoint

CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "broadcast_kind" NOT NULL,
	"channel" "campaign_channel" NOT NULL,
	-- The audience. `set null` rather than cascade: deleting a segment must not
	-- delete the record of what was already sent to it.
	"segment_id" uuid,
	/**
	 * **The audience as it was, not as it is.**
	 *
	 * A segment is a live query (`contact_segments.filters`), so re-resolving it
	 * a month later answers a different question. The filter is copied here when
	 * the broadcast is queued, so "who did this go to" has one answer forever —
	 * and `broadcast_recipients` holds the resolved list, which is the answer
	 * that actually matters.
	 */
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- The payload, one column per kind. Which one is required is a check
	-- constraint below rather than a comment, because a broadcast with nothing
	-- to send is a row that fails at 3am in a worker.
	"campaign_id" uuid,
	"survey_id" uuid,
	"template_name" text,
	"template_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- Null means "send when told". A time in the past is sent by the next sweep,
	-- which is the correct behaviour for a worker that was down.
	"scheduled_at" timestamp with time zone,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	-- Why nothing went out, when nothing did. Distinct from a per-recipient
	-- refusal: this is the whole send failing, e.g. the plan's credit is spent.
	"failure_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcasts_review_request_needs_campaign"
	  CHECK ("kind" <> 'review_request' OR "campaign_id" IS NOT NULL),
	CONSTRAINT "broadcasts_survey_needs_survey"
	  CHECK ("kind" <> 'survey' OR "survey_id" IS NOT NULL),
	CONSTRAINT "broadcasts_message_needs_template"
	  CHECK ("kind" <> 'message' OR "template_name" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_segment_id_contact_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."contact_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcasts_organization_id_idx" ON "broadcasts" USING btree ("organization_id","created_at" DESC);--> statement-breakpoint

/**
 * The due queue, and the reason it is partial.
 *
 * The sweep asks one question every minute — "is anything scheduled and due" —
 * across every tenant. Almost every row is `draft` or `sent` forever, so an
 * index over all of them would be mostly dead weight; this one contains only
 * the handful that are actually waiting. Cross-tenant on purpose: the sweep
 * runs before any tenant context exists, exactly as the sync scan does.
 */
CREATE INDEX "broadcasts_due_idx" ON "broadcasts" USING btree ("scheduled_at")
  WHERE "status" = 'scheduled';--> statement-breakpoint

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.broadcasts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.broadcasts
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcasts TO fairfame_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Who it went to, and what happened
-- ---------------------------------------------------------------------------
--
-- **The audience snapshot.** A segment is a live query; this is the list it
-- resolved to at send time, which is the only version of "who did this go to"
-- that stays true when somebody edits the segment afterwards.
--
-- Delivery and conversion are **pointers, not copies**. `review_requests`,
-- `survey_responses` and `messages` already track their own funnels — sent,
-- opened, submitted, answered, delivered — and duplicating any of that here
-- would create two numbers that can disagree. This table says which row a
-- recipient produced; the funnel says what became of it.
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "broadcast_recipient_status" DEFAULT 'pending' NOT NULL,
	-- The compliance gate's own reason, verbatim: `no_consent`, `opted_out`,
	-- `iys_not_configured`… Stored rather than summarised, because "48 need
	-- consent" and "48 are unreachable" are different problems.
	"refusal_reason" text,
	"review_request_id" uuid,
	"survey_response_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- One person, one place in a send. Also what makes a re-run idempotent.
	CONSTRAINT "broadcast_recipients_broadcast_contact_key" UNIQUE ("broadcast_id", "contact_id")
);
--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_review_request_id_review_requests_id_fk" FOREIGN KEY ("review_request_id") REFERENCES "public"."review_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_survey_response_id_survey_responses_id_fk" FOREIGN KEY ("survey_response_id") REFERENCES "public"."survey_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_broadcast_idx" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE INDEX "broadcast_recipients_contact_idx" ON "broadcast_recipients" USING btree ("contact_id");--> statement-breakpoint

ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.broadcast_recipients FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.broadcast_recipients
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcast_recipients TO fairfame_app;
