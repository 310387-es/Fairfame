-- Security posture for the BetterAuth tables added in 0002.
--
-- Two separate concerns:
--   1. `invitations` is tenant-owned, so it gets the same RLS treatment as the
--      rest of the tenant data.
--   2. `accounts`, `sessions` and `verifications` are auth internals. They are
--      reached only through BetterAuth, which runs on the owner connection, so
--      the runtime role has no business touching them at all.

-- ---------------------------------------------------------------------------
-- invitations: tenant-scoped like every other organization-owned table.
-- ---------------------------------------------------------------------------

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.invitations
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Auth internals: revoke the runtime role entirely.
--
-- `accounts` holds the password hashes and any OAuth refresh tokens, and
-- `verifications` holds live password-reset tokens. The default privileges
-- granted in migration 0001 handed fairfame_app full CRUD on these when 0002
-- created them, which is more than the application ever needs: it reaches
-- sessions and accounts only via BetterAuth, on the owner connection.
--
-- Revoking means a bug or an injection in application code cannot read a
-- password hash or mint a session, because the role simply holds no privilege
-- on the table. Defence in depth beneath RLS, not instead of it.
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.accounts FROM fairfame_app;--> statement-breakpoint
REVOKE ALL ON public.sessions FROM fairfame_app;--> statement-breakpoint
REVOKE ALL ON public.verifications FROM fairfame_app;--> statement-breakpoint

SELECT 1;
