-- Row-Level Security for the first-party collection tables (P1b-T1).
--
-- Same model as migration 0001: ENABLE + FORCE, and a policy keyed on the
-- transaction-local `app.current_org` GUC. FORCE matters as much as ENABLE —
-- without it the table owner bypasses its own policies and an isolation test
-- passes for the wrong reason.
--
-- Worth stating explicitly because these three tables are reachable from
-- unauthenticated routes: the public submission endpoint resolves a campaign
-- slug or request token with the owner connection (there is no session to
-- derive a tenant from), and every write it then performs runs inside
-- `withTenant()`. So even a forged slug can only ever write rows belonging to
-- the organization that slug actually names.

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.contacts
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.campaigns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.campaigns
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.review_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.review_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.review_requests
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

-- Migration 0001 set default privileges for future tables, but only for those
-- created by the `fairfame` role. Re-granting explicitly costs nothing and keeps
-- this migration correct on a database whose migrations were once applied by a
-- different owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts, public.campaigns, public.review_requests
  TO fairfame_app;
