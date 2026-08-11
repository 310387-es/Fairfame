-- Row-Level Security for the digest tables (P1a-T7).
--
-- Same model as every tenant table before it: ENABLE + FORCE, with a policy
-- keyed on the transaction-local `app.current_org` GUC.
--
-- A digest is the most concentrated tenant-owned object in the schema. One row
-- carries a business's reputation trend, the themes its customers complain
-- about, verbatim quotes from those customers, and the three things it has been
-- told to fix. That is a competitor's dream and a customer's personal data in
-- the same payload, so the boundary matters here at least as much as on
-- `reviews` itself.

ALTER TABLE public.digests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.digests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.digests
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.digest_actions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.digest_actions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.digest_actions
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.digests, public.digest_actions TO fairfame_app;
