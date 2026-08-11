-- `max_organizations` on every seeded plan (11 Aug 2026).
--
-- Adding a key to `LIMIT_KEYS` widens `entitlementsSchema`, and
-- `loadSubscription` validates `plans.entitlements` against it on **every**
-- resolve — deliberately, so a hand-edited blob fails loudly rather than
-- silently granting or denying a feature. That safety net is exactly what turns
-- a new key into a breaking change: without this statement the first
-- entitlement check after deploy throws for every organization on a seeded
-- plan, which is every organization.
--
-- The catalog stays the runtime authority; `resolveEntitlements` reads
-- `PLAN_CATALOG[planKey]` and only the *shape* comes from the row. So this
-- backfills the shape rather than inventing policy: the numbers below are the
-- same ones in `src/lib/plans.ts`, and `pnpm db:seed` writes them for a fresh
-- database.
--
-- Idempotent, and keyed on the plan rather than positional: a plan row already
-- carrying the key is left alone, so re-running is a no-op and a plan whose
-- entitlements were tuned by hand keeps its own value.
UPDATE "plans"
   SET "entitlements" = jsonb_set(
         "entitlements"::jsonb,
         '{limits,max_organizations}',
         CASE "key"
           WHEN 'starter' THEN '1'::jsonb
           WHEN 'growth'  THEN '2'::jsonb
           WHEN 'pro'     THEN '3'::jsonb
           -- Unlimited. An agency holds a workspace per client, and a number
           -- here would cap how many customers it may have.
           WHEN 'agency'  THEN 'null'::jsonb
           ELSE '1'::jsonb
         END,
         true
       )
 WHERE NOT ("entitlements"::jsonb -> 'limits' ? 'max_organizations');
