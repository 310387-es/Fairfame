import { and, eq, isNull, ne, or } from "drizzle-orm";
import { getAdminDb, schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";

/**
 * Which organization a session opens in (W1.1).
 *
 * **The bug this exists to close.** BetterAuth writes
 * `sessions.active_organization_id` only when something calls `setActive`, and
 * nothing called it on sign-in. `requireActor` reads that column and the app
 * shell redirects a session without one to `/create-organization` — so a
 * returning customer with a perfectly good organization was shown a form
 * inviting them to create a second, and could not reach a single screen of the
 * product until they did.
 *
 * **A preference is not a permission.** `users.last_active_organization_id`
 * records where somebody was last working; it is re-checked against
 * `memberships` every single time before it is believed. Being removed from an
 * organization, or an agency unlinking a client, must take effect at the next
 * sign-in rather than whenever the stale preference happens to be overwritten.
 * `memberships` remains the only thing that grants anything — this module can
 * only ever *narrow* to a row that already exists there.
 *
 * **Why adminDb.** Same reason `src/auth/session.ts` gives: "which
 * organizations do I belong to?" is by definition a cross-organization
 * question, asked before a tenant context can exist. Nothing tenant-owned is
 * read here — memberships and one id.
 */

const log = childLogger({ module: "auth/active-organization" });

/**
 * The organization this person's next session should open in, or null when
 * there is no honest answer.
 *
 * Null means one of three things, and the caller treats them alike: they belong
 * to nothing yet (signup), or they belong to several and have never chosen, or
 * the remembered one is no longer theirs and they belong to several others.
 * All three land on `/create-organization`, which offers a picker whenever
 * memberships exist — never a bare create form.
 */
export async function resolveActiveOrganization(userId: string): Promise<string | null> {
  const db = getAdminDb();

  const [user] = await db
    .select({ remembered: schema.users.lastActiveOrganizationId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (user?.remembered) {
    const [stillAMember] = await db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.organizationId, user.remembered),
          eq(schema.memberships.userId, userId),
        ),
      )
      .limit(1);

    if (stillAMember) return user.remembered;
  }

  // Two rows is the whole question: one means the answer is unambiguous, two
  // means there is a choice to put to the person. Reading the rest would be
  // reading rows to count past a number we stop caring about.
  const memberships = await db
    .select({ organizationId: schema.memberships.organizationId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId))
    .limit(2);

  return memberships.length === 1 ? (memberships[0]?.organizationId ?? null) : null;
}

/**
 * Remembers an organization somebody has actually switched into.
 *
 * Called from the session-update hook rather than from each caller of
 * `setActiveOrganization`, so a path added later cannot forget to record it —
 * the same reason `switchOrganizationAction` delegates its membership check
 * instead of re-implementing it.
 *
 * The write is conditional in SQL so the daily session refresh, which carries
 * an unchanged `activeOrganizationId` through the same hook, is a no-op rather
 * than a write per user per day.
 */
export async function rememberActiveOrganization(
  userId: string,
  organizationId: string,
): Promise<void> {
  try {
    await getAdminDb()
      .update(schema.users)
      .set({ lastActiveOrganizationId: organizationId })
      .where(
        and(
          eq(schema.users.id, userId),
          or(
            isNull(schema.users.lastActiveOrganizationId),
            ne(schema.users.lastActiveOrganizationId, organizationId),
          ),
        ),
      );
  } catch (error) {
    // Losing the memory costs one extra click at the next sign-in. Failing the
    // switch that is already committed to the session costs the switch.
    log.warn({ userId, organizationId, err: error }, "Failed to remember active organization");
  }
}
