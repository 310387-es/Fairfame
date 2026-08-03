-- Row-Level Security for the notification tables (P1a-T5).
--
-- Same model as 0001, 0006 and 0009: ENABLE + FORCE, with a policy keyed on
-- the transaction-local `app.current_org` GUC.
--
-- The tenant boundary is the only one enforced here. A notification also
-- belongs to a *user*, and one member of an organization must not read
-- another's feed — but that is not a Postgres policy, because `app.current_org`
-- is the only identity the database has. Per-user filtering happens in the data
-- layer (src/notifications/feed.ts), which is why every query there takes a
-- user id and why the tests assert on it directly.
--
-- Worth being explicit about, since "RLS protects it" is the assumption someone
-- will otherwise make: RLS stops tenant A reading tenant B, and nothing more.

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.notification_preferences FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.notification_preferences
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.notifications
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.notification_preferences, public.notifications
  TO revira_app;
