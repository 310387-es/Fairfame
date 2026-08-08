-- Web Push subscriptions (W5-9, item 9 on the Wave 5 backlog).
--
-- `docs/remediation-plan.md` justifies it in a parenthetical: *owners live on
-- their phone*. Everything about this product already assumes that — the rail
-- collapses, every screen is checked at 390px — except the one thing that makes
-- a website behave like something on a home screen, which is a notification
-- that arrives when the tab is closed.
--
-- ## Per user, with the organization alongside
--
-- A subscription belongs to a device somebody is holding, and one person may
-- work for two businesses. `organization_id` is on the row so RLS can scope it
-- and so a membership ending takes the subscription with it — a manager who
-- leaves must stop getting that business's alerts on their own phone, and the
-- cascade is what guarantees it rather than a job somebody has to remember.
--
-- ## `endpoint` is the identity
--
-- It is what the push service issues and what names the device, so it is
-- globally unique: the same phone re-subscribing updates rather than
-- accumulating a row per week. A browser that loses its keys produces a *new*
-- endpoint, and the stale one is deleted the first time a send comes back
-- `410 Gone` — which is the only reliable signal a device is gone.
--
-- ## Why the keys are plain columns
--
-- `p256dh` and `auth` are the device's own public key material. They are
-- useless without a message to encrypt and grant access to nothing, unlike an
-- OAuth token, which is a credential to somebody else's system and lives in the
-- vault. Putting them in the vault would suggest they are the same kind of
-- thing.
CREATE TABLE "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL UNIQUE,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "last_sent_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "push_subscriptions_user_idx"
  ON "push_subscriptions" ("organization_id", "user_id");--> statement-breakpoint

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.push_subscriptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.push_subscriptions
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO revira_app;
