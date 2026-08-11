-- Per-member location scope (P2-T4, docs/17-phase-2-build-plan.md).
--
-- `docs/06` §3 has always given every role a location scope, and the schema has
-- never had anywhere to put it. Assignment is what forces the issue: handing a
-- review to someone who cannot open it is not a workflow, so the inbox needs to
-- know who may see what before it can offer a list of assignees.
--
-- Additive and empty on arrival, which is the whole point — an empty table means
-- "nobody is restricted", so applying this changes nothing about who sees what
-- until somebody is deliberately scoped. The one exception is the `client` role,
-- which src/auth/scope.ts reads the other way round; there are no client
-- memberships today, so that is still a no-op in practice.

CREATE TABLE "member_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_locations_membership_location_key" UNIQUE("membership_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "member_locations" ADD CONSTRAINT "member_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_locations" ADD CONSTRAINT "member_locations_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_locations" ADD CONSTRAINT "member_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_locations_org_membership_idx" ON "member_locations" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "member_locations_location_idx" ON "member_locations" USING btree ("location_id");--> statement-breakpoint

-- Row-Level Security, on the same model as every tenant table since 0001.
--
-- Note what this policy does *not* do: it keeps one organization's scoping out
-- of another's, and nothing more. "Which locations may this member see" is a
-- product rule enforced in src/auth/scope.ts, not a database one — a policy that
-- filtered the table by the current user would make it impossible for an admin
-- to read, or edit, anybody's scope but their own.
ALTER TABLE public.member_locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.member_locations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.member_locations
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_locations TO fairfame_app;