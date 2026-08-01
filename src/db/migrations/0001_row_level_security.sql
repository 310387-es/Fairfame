-- Row-Level Security: tenant isolation enforced by Postgres, not by trust.
--
-- Model
-- -----
-- Two roles. `revira` owns the tables and runs migrations. `revira_app` is the
-- runtime role, created NOSUPERUSER / NOBYPASSRLS by the compose init script.
-- Every table below also gets FORCE ROW LEVEL SECURITY so the owner is subject
-- to its own policies too — without FORCE, the table owner silently bypasses
-- them and an isolation test can pass for entirely the wrong reason.
--
-- Tenant context travels in two transaction-local GUCs, set by
-- src/lib/tenancy.ts: `app.current_org` and `app.current_user`. When they are
-- unset, the helpers below return NULL, every policy predicate evaluates to
-- NULL (not true), and the tables read as empty. Denied by default.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- nullif() guards the empty string: ''::uuid raises, NULL simply matches nothing.
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_org', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_user', true), '')::uuid $$;
--> statement-breakpoint

-- SECURITY DEFINER so the membership lookup is not itself filtered by the
-- policy it is helping to evaluate. search_path is pinned: a SECURITY DEFINER
-- function with a mutable search_path is a privilege-escalation vector.
CREATE OR REPLACE FUNCTION app.is_member(target_org uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, app, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.organization_id = target_org
        AND m.user_id = app.current_user_id()
    )
  $$;
--> statement-breakpoint

-- The role normally exists already (compose init script). Created here without
-- LOGIN as a fallback so this migration never fails on a fresh database; the
-- init script is what grants it a password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'revira_app') THEN
    CREATE ROLE revira_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public, app TO revira_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO revira_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO revira_app;--> statement-breakpoint

-- `plans` is a global catalog, not tenant data: readable, never writable at runtime.
REVOKE INSERT, UPDATE, DELETE ON public.plans FROM revira_app;--> statement-breakpoint

-- Tables added by later migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE revira IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO revira_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE revira IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO revira_app;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tenant business data: strict organization_id scoping.
-- ---------------------------------------------------------------------------

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.locations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.locations
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.connections
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.reviews
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscriptions
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.usage_counters FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.usage_counters
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.audit_logs
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.consent_records FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.consent_records
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Identity tables. These are still tenant-owned, but auth legitimately reads
-- them before an active organization exists ("which orgs do I belong to?"),
-- so they also accept the current *user* as the scope.
-- ---------------------------------------------------------------------------

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY membership_read ON public.memberships FOR SELECT
  USING (organization_id = app.current_org() OR user_id = app.current_user_id());
--> statement-breakpoint
-- Covers the founding owner row: at org-creation time there is no active org
-- yet, and the user is adding themselves.
CREATE POLICY membership_insert ON public.memberships FOR INSERT
  WITH CHECK (
    organization_id = app.current_org()
    OR user_id = app.current_user_id()
    OR app.is_member(organization_id)
  );
--> statement-breakpoint
CREATE POLICY membership_update ON public.memberships FOR UPDATE
  USING (organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
--> statement-breakpoint
CREATE POLICY membership_delete ON public.memberships FOR DELETE
  USING (organization_id = app.current_org());
--> statement-breakpoint

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY organization_read ON public.organizations FOR SELECT
  USING (id = app.current_org() OR app.is_member(id));
--> statement-breakpoint
-- Anyone authenticated may create an organization; they simply cannot see
-- anyone else's afterwards.
CREATE POLICY organization_insert ON public.organizations FOR INSERT
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY organization_update ON public.organizations FOR UPDATE
  USING (id = app.current_org() OR app.is_member(id))
  WITH CHECK (id = app.current_org() OR app.is_member(id));
--> statement-breakpoint
CREATE POLICY organization_delete ON public.organizations FOR DELETE
  USING (id = app.current_org());
--> statement-breakpoint

-- `users` is deliberately NOT under RLS: it is global identity, not tenant
-- data, and BetterAuth must look up an account by email during login, before
-- any tenant context can possibly exist.
SELECT 1;
