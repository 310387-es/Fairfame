-- Channels, as a first-class thing (W2.2, docs/remediation-plan.md).
--
-- **Why not `connections`.** That table is the review-source table: every row
-- has a `location_id NOT NULL`, a sync cursor, a first-sync marker and a
-- capability snapshot, because a source is something you *poll* per branch. A
-- messaging channel is none of that. A WhatsApp Business Account belongs to the
-- **organization** — one account, one phone number, every branch — so bending it
-- into a per-location row would mean either picking a branch arbitrarily or
-- writing the same credentials once per branch and letting them drift.
--
-- The seam was already visible: "Connect WhatsApp Business" sat on the Locations
-- screen next to Google, and pressing it reached `syncConnection`, which threw
-- "Provider whatsapp cannot read reviews." W1.4 stopped offering it there; this
-- is the home it was waiting for.
--
-- **What this does not change.** `getWhatsAppClient()` reads deployment
-- credentials from the environment, and it still does. This table lets an
-- organization bring its own account, and the client prefers it when present —
-- so a single-tenant deployment keeps working with no rows here at all.
CREATE TABLE "channel_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  -- Reuses `message_channel`, so a channel here and a message row there cannot
  -- drift apart into two vocabularies for the same two words.
  "channel" "message_channel" NOT NULL,
  "status" "connection_status" NOT NULL DEFAULT 'pending',
  -- The provider's own identifiers: a phone number id, a WABA id. Non-secret,
  -- and needed to address a send.
  "external_id" text,
  "display_name" text,
  -- Non-secret settings. Credentials never go here.
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Encrypted at the application layer, exactly as `connections` does it.
  "encrypted_tokens" text,
  -- Why the last attempt failed, so a status card can say more than "error".
  "last_error" text,
  "connected_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One account per channel per organization. A business has one WhatsApp number;
-- two rows would mean two answers to "which token do we send with", and the
-- loser would be chosen by whichever query happened to sort first.
CREATE UNIQUE INDEX "channel_connections_org_channel_key"
  ON "channel_connections" ("organization_id", "channel");--> statement-breakpoint

ALTER TABLE public.channel_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.channel_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.channel_connections
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_connections TO fairfame_app;
