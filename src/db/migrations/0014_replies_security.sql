-- Row-Level Security for `replies` (P1a-T6).
--
-- Same model as 0001, 0006, 0009 and 0012: ENABLE + FORCE, with a policy keyed
-- on the transaction-local `app.current_org` GUC.
--
-- A reply is the one row in this schema the business *publishes under its own
-- name*. A cross-tenant read would expose an unapproved draft — what a business
-- was considering saying to an unhappy customer — and a cross-tenant write
-- would let one tenant put words in another's mouth on a public platform.
-- Neither is recoverable once posted.

ALTER TABLE public.replies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.replies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.replies
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.replies TO fairfame_app;
