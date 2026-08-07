import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminDb, schema } from "@/db/client";
import { safeNextPath } from "@/auth/next-path";
import { isRole, roleAtLeast, type Role } from "@/auth/permissions";
import { auth } from "@/auth/config";
import { withTenant, type TenantContext, type TenantDatabase } from "@/lib/tenancy";

/**
 * The bridge between an authenticated BetterAuth session and the Postgres
 * tenant context from T4.
 *
 * This is where authorization is decided. The active organization comes from
 * the server-side session, never from a request parameter — otherwise any user
 * could name someone else's organization and, worse, the RLS context would be
 * set to it.
 */

export type AuthenticatedActor = {
  userId: string;
  organizationId: string;
  role: Role;
};

export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class NoActiveOrganizationError extends Error {
  constructor(message = "No active organization for this session.") {
    super(message);
    this.name = "NoActiveOrganizationError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Insufficient role for this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The raw session, or null. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/**
 * The mirror of the app shell's guard: sends a signed-in visitor *away* from
 * the pre-authentication screens.
 *
 * It is a per-page call rather than a check in `(auth)/layout.tsx` for two
 * reasons, and both are structural. A layout cannot see its child's pathname in
 * the App Router — the constraint `invite/[id]` already records — and two of the
 * routes in that group are reachable *only* while signed in: choosing an
 * organization, and accepting an invitation. A guard in the layout would have to
 * exempt them, which means the exemption list and the pages could drift.
 *
 * `next` is honoured so a stale `?next=` link — `/sign-in?next=/invite/abc`,
 * followed by somebody who is already signed in — lands on the invitation
 * rather than dead-ending on Home. It is sanitised, because the whole point of
 * this function is that it redirects somebody who is already authenticated.
 */
export async function redirectIfSignedIn(next?: string | null): Promise<void> {
  if (await getSession()) redirect(safeNextPath(next) ?? "/dashboard");
}

/**
 * Resolves the acting user, their active organization, and their role in it.
 *
 * The membership is re-read from the database rather than trusted from the
 * session: a role change or a removal must take effect immediately, not
 * whenever the session cookie happens to refresh.
 */
export async function requireActor(): Promise<AuthenticatedActor> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) throw new NoActiveOrganizationError();

  const [membership] = await getAdminDb()
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.userId, session.user.id),
      ),
    )
    .limit(1);

  // An active organization the user is not a member of is not an authorization
  // failure to report in detail — treat it as having no active organization.
  if (!membership) throw new NoActiveOrganizationError();
  if (!isRole(membership.role)) {
    throw new ForbiddenError(`Unrecognised role "${membership.role}".`);
  }

  return { userId: session.user.id, organizationId, role: membership.role };
}

/** Throws unless the actor holds at least `required`. */
export function assertRoleAtLeast(actor: AuthenticatedActor, required: Role): void {
  if (!roleAtLeast(actor.role, required)) {
    throw new ForbiddenError(`Requires ${required} or higher; actor is ${actor.role}.`);
  }
}

export function toTenantContext(actor: AuthenticatedActor): TenantContext {
  return { organizationId: actor.organizationId, userId: actor.userId };
}

/**
 * The sanctioned entry point for tenant data in a request.
 *
 * Resolves the actor, optionally enforces a minimum role, then runs the
 * callback inside the RLS tenant context:
 *
 *   const rows = await withAuthenticatedTenant(
 *     (tx) => tx.select().from(reviews),
 *     { minimumRole: "member" },
 *   );
 */
export async function withAuthenticatedTenant<T>(
  fn: (tx: TenantDatabase, actor: AuthenticatedActor) => Promise<T>,
  options: { minimumRole?: Role } = {},
): Promise<T> {
  const actor = await requireActor();
  if (options.minimumRole) assertRoleAtLeast(actor, options.minimumRole);

  return withTenant(toTenantContext(actor), (tx) => fn(tx, actor));
}
