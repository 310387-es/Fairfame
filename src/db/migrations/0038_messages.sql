-- Two-way messaging (P4-T3, docs/20-phase-4-build-plan.md).
--
-- **The table `src/contacts/timeline.ts` has been apologising for since P4-T1.**
-- Until now the only record of a conversation was `whatsapp_conversations`,
-- which holds two timestamps — last inbound, last outbound — because that is
-- all Meta's 24-hour service window needs. That made the contact timeline
-- render at most two message events which *moved* rather than accumulated. This
-- is the per-message log, and the timeline stops approximating.
--
-- `whatsapp_conversations` stays, and is not replaced. It records a **WhatsApp
-- rule** — whether the customer-service window is open — which SMS does not
-- have and which the compliance gate reads on every send. Folding it into a
-- message log would mean the gate had to derive a legal fact by scanning rows.
--
-- **There is deliberately no `conversations` table.** A conversation is the
-- messages with one contact, in order; an entity holding a title and a
-- participant list would duplicate `contacts` and immediately be able to
-- disagree with it. The inbox is a `DISTINCT ON (contact_id)` over this table.

CREATE TYPE "message_channel" AS ENUM('whatsapp', 'sms');--> statement-breakpoint
CREATE TYPE "message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
-- The union of both directions' lifecycles. `received` is the only inbound
-- state — there is nothing to track after a message arrives — while an outbound
-- one walks queued → sent → delivered → read, or lands on failed.
CREATE TYPE "message_status" AS ENUM(
  'received', 'queued', 'sent', 'delivered', 'read', 'failed'
);--> statement-breakpoint

CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	-- Not nullable. A message from a number we hold no contact for is **not
	-- stored** (see `resolveContact` in whatsapp-inbound.ts): recording it would
	-- create a person nobody consented to give us.
	"contact_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"status" "message_status" NOT NULL,
	"body" text,
	-- The approved template an outbound message was sent as, if it was one.
	-- Null for free text and for everything inbound.
	"template_name" text,
	-- The platform's id: a WhatsApp `wamid`, an SMS gateway reference. Delivery
	-- receipts arrive asynchronously and key on it.
	"external_id" text,
	-- Who pressed send. Null for inbound and for anything the product sent on
	-- its own; `set null` because a message outlives the person who sent it.
	"sent_by_user_id" uuid,
	/**
	 * **The compliance record, and the reason this column is not derivable.**
	 *
	 * Every outbound message was allowed out under exactly one basis: a
	 * `commercial` one, resting on a registered İYS permission, or a `service`
	 * reply inside the 24-hour window the customer themself opened. That is the
	 * question a regulator asks — "on what basis did you send this" — and
	 * recomputing it a year later would answer with today's window state rather
	 * than the one that applied at the time. Null for inbound.
	 */
	"intent" text,
	"failure_reason" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- An outbound message has a basis; an inbound one cannot have had.
	CONSTRAINT "messages_intent_matches_direction" CHECK (
	  ("direction" = 'outbound') OR ("intent" IS NULL)
	),
	-- `received` belongs to inbound and to nothing else, so a thread cannot
	-- contain an outbound message that never claimed to have been sent.
	CONSTRAINT "messages_status_matches_direction" CHECK (
	  ("direction" = 'inbound') = ("status" = 'received')
	)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- One thread, newest last when read forwards.
CREATE INDEX "messages_org_contact_created_idx" ON "messages" USING btree ("organization_id","contact_id","created_at" DESC);--> statement-breakpoint
-- The conversations list: DISTINCT ON (contact_id) needs contact then time.
CREATE INDEX "messages_org_created_idx" ON "messages" USING btree ("organization_id","created_at" DESC);--> statement-breakpoint

/**
 * Webhook dedup.
 *
 * **Meta may deliver the same webhook more than once — they say so.** Without
 * this a redelivery puts the customer's message in the thread twice, which
 * looks like the customer repeating themself and is impossible to tell from
 * them actually doing so. Partial, because an outbound message has no external
 * id until the platform accepts it, and several may be queued at once.
 */
CREATE UNIQUE INDEX "messages_org_channel_external_key"
  ON "messages" USING btree ("organization_id","channel","external_id")
  WHERE "external_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.messages
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO fairfame_app;
