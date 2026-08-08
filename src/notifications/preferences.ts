import { and, eq, isNull, or } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import { quietWindowOf, type QuietWindow } from "./quiet-hours.ts";

/**
 * Who gets told what (P1a-T5).
 *
 * Resolution is one rule: **the most specific row wins.** A preference for the
 * exact location beats the user's organization-wide default (`location_id is
 * null`), which beats the system default below. Anything more elaborate — a
 * membership column, a merge of partial settings — turns "why did I not get
 * this email?" into an investigation.
 *
 * The pure decision function is separated from the query on purpose: whether a
 * given review should notify a given user is the part worth testing
 * exhaustively, and it needs no database to answer.
 */

export type NotificationScope = (typeof schema.notificationScopeEnum.enumValues)[number];
export type NotificationDelivery = (typeof schema.notificationDeliveryEnum.enumValues)[number];

export type Preference = {
  scope: NotificationScope;
  delivery: NotificationDelivery;
  inApp: boolean;
  email: boolean;
  /**
   * The nightly window in which email waits (W5-15). Null means none.
   *
   * On the preference rather than on the user, because it follows the same
   * most-specific-wins resolution everything else here does — somebody covering
   * one branch overnight can keep that branch loud and the rest quiet.
   */
  quiet: QuietWindow | null;
};

/**
 * What a user gets before touching any setting.
 *
 * PRD N1 promises an in-app *and* email notification on a new review, so both
 * channels start on. An owner who finds that noisy has "negative only" one
 * click away; an owner who never receives the first alert has no reason to
 * look for the setting at all.
 */
export const DEFAULT_PREFERENCE: Preference = {
  scope: "all",
  delivery: "instant",
  inApp: true,
  email: true,
  // Nobody gets quiet hours they did not ask for: a business that wants to
  // hear about a one-star review at 23:00 is a business that should.
  quiet: null,
};

/**
 * Roles that are notified without opting in.
 *
 * `client` is excluded: it is the read-only role given to an outside party —
 * an agency's customer, a franchisee's head office — and mailing them every
 * review by default is a disclosure decision the organization has not made.
 * They still receive notifications the moment someone creates a preference row
 * for them, which is what makes this a default rather than a prohibition.
 */
export const AUTO_NOTIFIED_ROLES = ["owner", "admin", "member"] as const;

export type Recipient = {
  userId: string;
  email: string;
  name: string | null;
  locale: string | null;
  role: (typeof schema.membershipRoleEnum.enumValues)[number];
  preference: Preference;
};

/**
 * Should this user hear about this review, and how?
 *
 * Pure. `negative` is the caller's verdict, not something re-derived here —
 * see ./service.ts for what counts.
 */
export function shouldNotify(
  preference: Preference,
  options: { negative: boolean },
): { inApp: boolean; email: boolean; deferEmail: boolean } {
  const wanted =
    preference.scope === "all" || (preference.scope === "negative_only" && options.negative);

  if (!wanted) return { inApp: false, email: false, deferEmail: false };

  return {
    inApp: preference.inApp,
    // "Digest" still creates the feed entry — it defers the *email*. Suppressing
    // the in-app row too would leave a user who chose a calmer inbox with no
    // record of the review at all.
    email: preference.email && preference.delivery === "instant",
    deferEmail: preference.email && preference.delivery === "digest",
  };
}

/**
 * Everyone in the organization who could be notified, with their resolved
 * preference for one location.
 *
 * A single query rather than one per member: an organization with fifty
 * members and a busy location would otherwise issue fifty round trips per
 * incoming review.
 */
export async function recipientsForLocation(
  tx: TenantDatabase,
  organizationId: string,
  locationId: string,
): Promise<Recipient[]> {
  const rows = await tx
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      locale: schema.users.locale,
      role: schema.memberships.role,
      prefLocationId: schema.notificationPreferences.locationId,
      scope: schema.notificationPreferences.scope,
      delivery: schema.notificationPreferences.delivery,
      inApp: schema.notificationPreferences.inApp,
      email_: schema.notificationPreferences.email,
      quietFrom: schema.notificationPreferences.quietFrom,
      quietTo: schema.notificationPreferences.quietTo,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .leftJoin(
      schema.notificationPreferences,
      and(
        eq(schema.notificationPreferences.organizationId, organizationId),
        eq(schema.notificationPreferences.userId, schema.memberships.userId),
        // Both candidate rows are joined; the reducer below picks the specific
        // one. Filtering to the location here would hide the default.
        or(
          eq(schema.notificationPreferences.locationId, locationId),
          isNull(schema.notificationPreferences.locationId),
        ),
      ),
    )
    .where(eq(schema.memberships.organizationId, organizationId));

  // Group first, decide second. A user with both a default row and a location
  // override appears twice in the result set, and picking as we iterate makes
  // the answer depend on row order.
  type Row = (typeof rows)[number];
  const byUser = new Map<string, Row[]>();

  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (existing) existing.push(row);
    else byUser.set(row.userId, [row]);
  }

  return [...byUser.values()].flatMap((userRows) => {
    const first = userRows[0];
    if (!first) return [];

    const withPreference = userRows.filter((row) => row.scope !== null);
    // Most specific wins: the location override, then the default.
    const chosen =
      withPreference.find((row) => row.prefLocationId !== null) ?? withPreference[0] ?? null;

    const preference: Preference = chosen
      ? {
          scope: chosen.scope!,
          delivery: chosen.delivery!,
          inApp: chosen.inApp!,
          email: chosen.email_!,
          quiet: quietWindowOf(chosen.quietFrom, chosen.quietTo),
        }
      : // No row at all: the default applies, except to `client`, which is
        // opted out until someone says otherwise.
        AUTO_NOTIFIED_ROLES.includes(first.role as (typeof AUTO_NOTIFIED_ROLES)[number])
        ? DEFAULT_PREFERENCE
        : { ...DEFAULT_PREFERENCE, scope: "off" };

    return [
      {
        userId: first.userId,
        email: first.email,
        name: first.name,
        locale: first.locale,
        role: first.role,
        preference,
      },
    ];
  });
}

export type PreferenceRow = typeof schema.notificationPreferences.$inferSelect;

/** Every preference row a user has in this organization, defaults first. */
export async function preferencesForUser(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
): Promise<PreferenceRow[]> {
  return tx
    .select()
    .from(schema.notificationPreferences)
    .where(
      and(
        eq(schema.notificationPreferences.organizationId, organizationId),
        eq(schema.notificationPreferences.userId, userId),
      ),
    );
}

/**
 * Writes one preference. `locationId: null` sets the organization-wide default.
 *
 * Upsert on the unique key, which is declared NULLS NOT DISTINCT precisely so
 * the default is a single row rather than one per save.
 */
export async function savePreference(
  tx: TenantDatabase,
  input: {
    organizationId: string;
    userId: string;
    locationId: string | null;
    scope: NotificationScope;
    delivery: NotificationDelivery;
    inApp: boolean;
    email: boolean;
    /**
     * Null clears the window; see `quiet-hours.ts` (W5-15).
     *
     * Optional so that every existing caller — and every test written before
     * quiet hours existed — keeps meaning "no quiet hours", which is both the
     * old behaviour and the right default: nobody should be given silence they
     * did not ask for.
     */
    quiet?: QuietWindow | null;
  },
): Promise<void> {
  await tx
    .insert(schema.notificationPreferences)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      locationId: input.locationId,
      scope: input.scope,
      delivery: input.delivery,
      inApp: input.inApp,
      email: input.email,
      quietFrom: input.quiet?.from ?? null,
      quietTo: input.quiet?.to ?? null,
    })
    .onConflictDoUpdate({
      target: [
        schema.notificationPreferences.organizationId,
        schema.notificationPreferences.userId,
        schema.notificationPreferences.locationId,
      ],
      set: {
        scope: input.scope,
        delivery: input.delivery,
        inApp: input.inApp,
        email: input.email,
        quietFrom: input.quiet?.from ?? null,
        quietTo: input.quiet?.to ?? null,
        updatedAt: new Date(),
      },
    });
}

/** Drops a location override so the user's default applies again. */
export async function clearPreference(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  locationId: string,
): Promise<void> {
  await tx
    .delete(schema.notificationPreferences)
    .where(
      and(
        eq(schema.notificationPreferences.organizationId, organizationId),
        eq(schema.notificationPreferences.userId, userId),
        eq(schema.notificationPreferences.locationId, locationId),
      ),
    );
}
