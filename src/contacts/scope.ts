import { sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { LocationScope } from "../auth/scope.ts";

/**
 * Which contacts a person may see (P4-T1).
 *
 * **The one hard question in T1, and it is a security question.** `contacts` is
 * an organization-level table: it has no `location_id`, because a customer
 * belongs to the business rather than to a branch. RLS therefore stops another
 * *tenant* reading this list and has nothing to say about a member who has been
 * pinned to one branch — which would leave a Kadıköy shift manager, or an
 * agency's `client` user, reading the whole customer file of a chain.
 *
 * `src/insights/facts.ts` settled the shape of the answer for Phase 3 and this
 * follows it exactly: **the member's scope is the filter, and an empty scope
 * returns nothing rather than everything.** That is the failure mode worth
 * naming twice — an unrestricted admin never sees the bug, so a version that
 * leaks looks perfect to the person most likely to test it.
 *
 * A contact reaches a location by having *interacted* with it: an outbound ask
 * carries the campaign's location, a walk-in submission records one too
 * (`recordWalkInRequest`), and since P4-T2 a survey invitation or answer carries
 * the survey's. Both arms are below. P4-T3 adds conversations as a third, and
 * this stays the only place that has to change.
 *
 * **A contact with no interaction at all is invisible to a restricted member**,
 * which is the honest answer rather than a convenient one: there is no branch to
 * attribute an imported row to, and guessing would be the leak. An unrestricted
 * member — every owner, and any admin or member not pinned to a location — sees
 * them, so nothing becomes unreachable.
 *
 * Every reader of the contact list goes through this: the list query, the
 * counts beside a segment, the profile page, the timeline, and (P4-T4) a
 * campaign's audience. A second interpretation of "may see this contact" is how
 * one of them ends up wrong.
 */

/**
 * `"contacts"."id"`, written out rather than interpolated as a column.
 *
 * **Not a style choice — the fix for a silent wrong answer.** Drizzle renders a
 * column interpolated into a `sql` fragment *unqualified* when that fragment
 * sits in the SELECT projection: `"id"`, not `"contacts"."id"`. Inside a
 * correlated subquery, bare `"id"` then resolves against the innermost scope,
 * so `where rr.contact_id = "id"` silently became `rr.contact_id = rr.id` — no
 * error, no warning, every row null. It renders correctly in a WHERE clause,
 * which is exactly why the scope tests passed while "last activity" read "No
 * activity yet" for everybody.
 *
 * Interpolating the *table* gives `"contacts"`, which is stable in both
 * positions. Every correlated subquery in this module and in ./queries.ts
 * builds its reference from this, so the two cannot diverge again.
 */
export const CONTACT_ID = sql`${schema.contacts}."id"`;

/** The scope clause, or `undefined` when the reader is unrestricted. */
export function contactScopeClause(scope: LocationScope): SQL | undefined {
  if (scope.all) return undefined;

  // Pinned to nothing at all. `false` rather than "no clause": the whole point
  // of the `client` role's empty default (src/auth/scope.ts) is that it means
  // *nothing*, and a missing predicate would turn it into *everything*.
  if (scope.locationIds.length === 0) return sql`false`;

  const locations = sql.param(scope.locationIds);

  return sql`(
    exists (
      select 1
        from ${schema.reviewRequests} rr
       where rr.contact_id = ${CONTACT_ID}
         and rr.location_id = any(${locations}::uuid[])
    )
    or exists (
      select 1
        from ${schema.surveyResponses} sr
       where sr.contact_id = ${CONTACT_ID}
         and sr.location_id = any(${locations}::uuid[])
    )
  )`;
}

/**
 * May this person open this one contact?
 *
 * Expressed as the same clause rather than as a second rule, so the profile
 * page cannot disagree with the list that linked to it — the bug where a row is
 * hidden from the list and still readable by URL.
 */
export function contactVisibleClause(scope: LocationScope, contactId: string): SQL {
  const scoped = contactScopeClause(scope);
  const identity = sql`${CONTACT_ID} = ${contactId}`;
  return scoped ? sql`${identity} and ${scoped}` : identity;
}
