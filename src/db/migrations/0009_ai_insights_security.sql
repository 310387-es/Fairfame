-- Row-Level Security for the AI tables (P1a-T2).
--
-- Same model as migrations 0001 and 0006: ENABLE + FORCE, with a policy keyed
-- on the transaction-local `app.current_org` GUC.
--
-- These two matter as much as `reviews` itself. An insight is derived from a
-- review, so it carries the same personal data by inference — sentiment and
-- themes about an identifiable person's visit — and the embedding is worse
-- still: a 768-dimension vector of the review's meaning, from which the
-- content can be partially reconstructed. Neither may be readable across a
-- tenant boundary, and the derived-data argument ("it's only a summary") is
-- exactly the reasoning that leaks it.

ALTER TABLE public.review_insights ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.review_insights FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.review_insights
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tags
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

-- Migration 0001 set default privileges for tables created by `revira`;
-- granting explicitly keeps this correct on a database whose migrations were
-- once applied by a different owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_insights, public.tags TO revira_app;
