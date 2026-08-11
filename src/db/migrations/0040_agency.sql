-- Agency / white-label (P4-T5, docs/20-phase-4-build-plan.md).
--
-- Two things, and the distinction between them is the whole security design:
--
--   1. **A link** — which client organizations an agency looks after. Recorded
--      here, and it grants **nothing**.
--   2. **Membership** — which organizations a person may read. Recorded in
--      `memberships`, exactly as it has been since Phase 0, and it is the only
--      thing that grants anything.
--
-- The agency console lists a client only when *both* hold. A link on its own
-- must never open a door, because RLS is per-organization and the moment a
-- relationship table could widen `app.current_org()` the product would have two
-- answers to "may this person read this row".

CREATE TABLE "agency_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- The agency. Named `organization_id` so the standard tenant policy applies
	-- unchanged: the row belongs to the agency, and the agency alone may see it.
	"organization_id" uuid NOT NULL,
	"client_organization_id" uuid NOT NULL,
	-- What the agency calls this client internally. Null shows the client's own
	-- name — the usual case, and the one that stays right when they rename.
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_clients_pair_key" UNIQUE ("organization_id", "client_organization_id"),
	-- An agency is not its own client. Without this the console would list the
	-- agency inside itself and the branding resolver would recurse.
	CONSTRAINT "agency_clients_not_self" CHECK ("organization_id" <> "client_organization_id")
);
--> statement-breakpoint
ALTER TABLE "agency_clients" ADD CONSTRAINT "agency_clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_clients" ADD CONSTRAINT "agency_clients_client_organization_id_organizations_id_fk" FOREIGN KEY ("client_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agency_clients_organization_id_idx" ON "agency_clients" USING btree ("organization_id");--> statement-breakpoint
-- "who looks after this organization" — the branding resolver's question, asked
-- from the client's side.
CREATE INDEX "agency_clients_client_idx" ON "agency_clients" USING btree ("client_organization_id");--> statement-breakpoint

ALTER TABLE public.agency_clients ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.agency_clients FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.agency_clients
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agency_clients TO fairfame_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Branding
-- ---------------------------------------------------------------------------
--
-- `organizations.logo` already exists (BetterAuth's column) and stays the logo.
-- What is added is the rest of a brand, and the address it lives at.
--
-- **On the organization, not on the agency link**, because an ordinary business
-- can brand its own public pages too — that is not a white-label feature, it is
-- just having a logo. What the `white_label` entitlement gates is an *agency's*
-- brand being applied to somebody else's pages, which is a different act.
ALTER TABLE "organizations" ADD COLUMN "branding" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

/**
 * The domain a client's public pages are served from.
 *
 * Globally unique because it is a hostname. **Storing it is not serving it** —
 * DNS and a certificate are infrastructure this application cannot provision,
 * so until go-live this column is what the URL builders read and nothing more.
 * `docs/13` records the step; `src/agency/branding.ts` says so where somebody
 * would go looking.
 */
ALTER TABLE "organizations" ADD COLUMN "custom_domain" text;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_custom_domain_key" ON "organizations" USING btree ("custom_domain")
  WHERE "custom_domain" IS NOT NULL;
