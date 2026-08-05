-- Where a returning user lands (W1.1, docs/remediation-plan.md).
--
-- BetterAuth writes `sessions.active_organization_id` only when something calls
-- `setActive`. Nothing called it on sign-in, so every returning session began
-- with a null tenant — and the app shell, which reads exactly that column,
-- redirected to `/create-organization`. A customer who already had an
-- organization was invited to make a second one, and every route in the product
-- was unreachable until they did.
--
-- A session is short-lived and a preference is not, so the memory belongs on
-- the user. `src/auth/active-organization.ts` reads it on session create and
-- **re-checks membership before trusting it** — a remembered organization
-- somebody has since been removed from must not become their tenant context.
-- This column is a preference; `memberships` remains the only thing that grants
-- anything.
--
-- ON DELETE SET NULL, not CASCADE: deleting an organization must forget the
-- preference, not the person.
ALTER TABLE "users" ADD COLUMN "last_active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_active_organization_id_organizations_id_fk" FOREIGN KEY ("last_active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Backfill everybody whose answer is already unambiguous. The resolver would
-- reach the same conclusion from the sole membership, so this changes no
-- behaviour; it means the column carries the truth from the first sign-in
-- rather than the fallback path carrying it forever.
UPDATE "users" u
   SET "last_active_organization_id" = m."organization_id"
  FROM "memberships" m
 WHERE m."user_id" = u."id"
   AND u."last_active_organization_id" IS NULL
   AND (SELECT count(*) FROM "memberships" m2 WHERE m2."user_id" = u."id") = 1;
