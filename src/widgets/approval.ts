import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";
import type { WidgetFilters } from "./config.ts";
import { allOf, widgetSelectionConditions, type WidgetScope } from "./scope.ts";

/**
 * Choosing which reviews a business shows on its own site.
 *
 * **Approval is a property of the review, not of the widget.** One flag,
 * `reviews.display_approved_at`, and every widget, badge and public surface
 * reads the same one. The builder is where it is *set* because that is where
 * somebody is thinking about their showcase, but the copy there has to say
 * plainly that approving a review approves it everywhere — a per-widget reading
 * of a global flag is the kind of misunderstanding that ends with a business
 * surprised by where a quote turned up.
 *
 * **Why bulk approval exists, and why it is honest.** A business with eight
 * hundred Google reviews will not clear them one at a time, and a product that
 * requires it ships a showcase nobody fills. So `approveAllMatching` exists —
 * and it records what it did: the filter it ran under and the number it touched
 * go into the audit log, so "who approved this quote" has an answer even when
 * the answer is "this person, in one action, along with 612 others". A bulk
 * action that left no trace would make the timestamp column decorative.
 *
 * Unapproval is deliberately easier than approval: no filter, no ceremony, and
 * it works on anything. Taking something down is the operation you never want
 * to make someone fight for.
 */

/** How many candidates the builder loads at once. */
export const CANDIDATE_PAGE_SIZE = 24;

export type DisplayCandidate = {
  id: string;
  rating: number | null;
  text: string | null;
  authorName: string | null;
  source: string;
  postedAt: Date | null;
  approvedAt: Date | null;
};

export type CandidatePage = {
  candidates: DisplayCandidate[];
  /** Everything matching, not just this page — the number "approve all" acts on. */
  matching: number;
  approved: number;
};

/**
 * The reviews a widget *could* show, approved or not.
 *
 * `approvedOnly: false` is the whole point: a list that already applied the
 * approval gate would be empty for every new widget, and nobody could ever
 * approve a first review. The gate is applied when the widget renders, not when
 * a business is deciding.
 */
export async function listDisplayCandidates(
  tx: TenantDatabase,
  scope: WidgetScope,
  filters: WidgetFilters,
  options: { offset?: number; limit?: number } = {},
): Promise<CandidatePage> {
  const conditions = widgetSelectionConditions(scope, filters, { approvedOnly: false });
  const limit = options.limit ?? CANDIDATE_PAGE_SIZE;

  const candidates = await tx
    .select({
      id: schema.reviews.id,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      authorName: schema.reviews.authorName,
      source: schema.reviews.source,
      postedAt: schema.reviews.postedAt,
      approvedAt: schema.reviews.displayApprovedAt,
    })
    .from(schema.reviews)
    .where(allOf(conditions))
    // The same order the widget renders in, so what a business approves at the
    // top of the list is what appears at the top of the widget.
    .orderBy(sql`${schema.reviews.postedAt} desc nulls last`, desc(schema.reviews.id))
    .limit(limit)
    .offset(options.offset ?? 0);

  const [totals] = await tx
    .select({
      matching: count(),
      approved: sql<number>`count(*) filter (where ${schema.reviews.displayApprovedAt} is not null)`,
    })
    .from(schema.reviews)
    .where(allOf(conditions));

  return {
    candidates,
    matching: totals?.matching ?? 0,
    // `count(*) filter` comes back as a bigint string on some drivers.
    approved: Number(totals?.approved ?? 0),
  };
}

export type ApprovalChange = {
  organizationId: string;
  actorUserId: string;
  approved: boolean;
};

/**
 * Approves or withdraws specific reviews.
 *
 * Returns how many rows actually changed, which is not the same as how many
 * were asked for: a review already approved is left alone rather than
 * re-stamped, so a double-click does not rewrite who approved it or when.
 *
 * A direct message reaching here is a bug upstream — `widgetSelectionConditions`
 * excludes them and the database refuses them — so the WHERE clause simply does
 * not match one, and the count comes back lower rather than raising.
 */
export async function setDisplayApproval(
  tx: TenantDatabase,
  change: ApprovalChange,
  reviewIds: string[],
  now = new Date(),
): Promise<number> {
  if (reviewIds.length === 0) return 0;

  const changed = await tx
    .update(schema.reviews)
    .set(
      change.approved
        ? {
            displayApprovedAt: now,
            displayApprovedByUserId: change.actorUserId,
            updatedAt: now,
          }
        : { displayApprovedAt: null, displayApprovedByUserId: null, updatedAt: now },
    )
    .where(
      and(
        eq(schema.reviews.organizationId, change.organizationId),
        inArray(schema.reviews.id, reviewIds),
        // Idempotent: only rows whose state would actually change.
        change.approved
          ? sql`${schema.reviews.displayApprovedAt} is null`
          : isNotNull(schema.reviews.displayApprovedAt),
        // Belt and braces against a caller that built its own id list.
        sql`${schema.reviews.itemType} <> 'dm'`,
      ),
    )
    .returning({ id: schema.reviews.id });

  if (changed.length > 0) {
    await recordApproval(tx, change, changed.length, { reviewIds });
  }

  return changed.length;
}

/**
 * Approves everything matching a widget's current selection.
 *
 * The set is defined by the same clauses the widget renders by, so "approve all
 * 47" means the 47 the builder just showed — not 47 chosen by a second, similar
 * query written for this function.
 */
export async function approveAllMatching(
  tx: TenantDatabase,
  change: Omit<ApprovalChange, "approved">,
  scope: WidgetScope,
  filters: WidgetFilters,
  now = new Date(),
): Promise<number> {
  const conditions = widgetSelectionConditions(scope, filters, { approvedOnly: false });

  const changed = await tx
    .update(schema.reviews)
    .set({
      displayApprovedAt: now,
      displayApprovedByUserId: change.actorUserId,
      updatedAt: now,
    })
    .where(and(allOf(conditions), sql`${schema.reviews.displayApprovedAt} is null`))
    .returning({ id: schema.reviews.id });

  if (changed.length > 0) {
    await recordApproval(
      tx,
      { ...change, approved: true },
      changed.length,
      // The filter goes in the record, not just the count. "Approved 612
      // reviews" is not an answer to what was approved; "everything 4★ and up
      // from Google at Kadıköy" is.
      { scope, filters },
    );
  }

  return changed.length;
}

/**
 * One audit row per action, not per review.
 *
 * Six hundred rows for one click would bury every other entry in the log and
 * say nothing the count does not. The `entity` names the action, and `meta`
 * carries what it covered.
 */
async function recordApproval(
  tx: TenantDatabase,
  change: ApprovalChange,
  affected: number,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    organizationId: change.organizationId,
    actorUserId: change.actorUserId,
    action: change.approved ? "review.display_approved" : "review.display_withdrawn",
    entity: `reviews:${affected}`,
    meta: { affected, ...detail },
  });
}
