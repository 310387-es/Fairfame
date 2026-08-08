import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { getConnector } from "../connectors/registry.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { renderTemplate } from "./template-vars.ts";
import { appendSignature } from "./style.ts";
import { approveReply, postReply, writeReplyDraft, type ReplyRow } from "./service.ts";

/**
 * Auto-reply to a wordless five-star review (W5-6).
 *
 * > **Auto-reply rules** ("auto-post AI reply to 5★ with no text after 24h;
 * > queue the rest" — the AI-native time-saver, all pieces exist).
 *
 * ## The rule this does not break
 *
 * `src/replies/service.ts` has said since P1a-T6 that nothing the model wrote
 * reaches a platform without an explicit human approval, and named this exact
 * feature as the thing that must not slip past unnoticed. It did not slip past.
 * The rule holds, because **the model is not in this path at all** — and that
 * is not a compromise, it is what the condition forces:
 *
 * `draftReplyForReview` *refuses* a review with no text ("There is nothing to
 * reply to — this review is a rating with no text"). A generated reply to a
 * wordless five star would therefore be generated from the star alone, which
 * means inventing the only content it has. So what gets posted is a template
 * **the business wrote themselves**, rendered with the variables the composer
 * already offers. The words on the platform are the owner's words.
 *
 * ## Why this case and no other
 *
 * A five-star review with no text is the one review in the product where a
 * canned answer is the *correct* answer. There is nothing specific to respond
 * to, nothing to get wrong, no complaint to mishandle and no fact to fabricate;
 * the honest reply is a thank-you, and a business typing the same thank-you
 * four hundred times is doing work a computer should do.
 *
 * Everything else queues, exactly as the plan says. In particular:
 *
 *   - **Never a review with words**, however positive. "Five stars, but the
 *     coffee was cold" is a five-star review with something in it, and a canned
 *     thank-you to it reads as not having been read.
 *   - **Never below five stars.** Not four. A four-star review is somebody
 *     telling you what to fix.
 *   - **Never a DM**, and never a source that cannot take a reply through its
 *     API — the same capability check `postReply` makes.
 *   - **Never twice.** A review that already has any live reply, or that the
 *     owner has already answered on the platform, is skipped.
 *
 * ## The delay is the point
 *
 * The rule waits `auto_reply_delay_hours` from the review being posted. That
 * window is what makes this reversible by a person rather than by a support
 * ticket: anybody watching the Inbox can answer it themselves — which takes it
 * out of scope, since it then has a live reply — or switch the rule off.
 */

const log = childLogger({ module: "replies/auto" });

/** Locations examined per sweep. Bounded like every other sweep in the product. */
const SWEEP_LOCATIONS = 200;

/** Reviews auto-answered per location per run. */
export const AUTO_REPLY_BATCH = 25;

/**
 * The rating that qualifies. Five, and the constant exists to be searched for
 * rather than to be tuned — see the module comment on why four does not.
 */
export const AUTO_REPLY_RATING = 5;

export type AutoReplyRule = {
  locationId: string;
  organizationId: string;
  templateId: string;
  delayHours: number;
};

export type AutoReplyOutcome = {
  posted: number;
  failed: number;
  /** Reviews that matched but whose source cannot take an API reply. */
  unpostable: number;
};

/** Locations with the rule switched on. Cross-tenant: a sweep has no session. */
export async function locationsWithAutoReply(
  db: { select: TenantDatabase["select"] },
  limit = SWEEP_LOCATIONS,
): Promise<AutoReplyRule[]> {
  const rows = await db
    .select({
      locationId: schema.locations.id,
      organizationId: schema.locations.organizationId,
      templateId: schema.locations.autoReplyTemplateId,
      delayHours: schema.locations.autoReplyDelayHours,
    })
    .from(schema.locations)
    .where(sql`${schema.locations.autoReplyTemplateId} is not null`)
    .limit(limit);

  return rows.flatMap((row) => (row.templateId ? [{ ...row, templateId: row.templateId }] : []));
}

export type AutoReplyCandidate = {
  reviewId: string;
  authorName: string | null;
  source: string;
  locationName: string;
  organizationName: string;
};

/**
 * Reviews this rule should answer, right now.
 *
 * Every clause here is a refusal, and each one is in SQL rather than in a
 * filter afterwards so that a future caller cannot get the set by accident:
 * five stars exactly, no text at all, nothing the owner has already answered,
 * nothing that already has a live reply of ours, and nothing newer than the
 * delay.
 */
export async function autoReplyCandidates(
  tx: TenantDatabase,
  rule: AutoReplyRule,
  now = new Date(),
  limit = AUTO_REPLY_BATCH,
): Promise<AutoReplyCandidate[]> {
  const cutoff = new Date(now.getTime() - rule.delayHours * 60 * 60 * 1_000);

  return (
    tx
      .select({
        reviewId: schema.reviews.id,
        authorName: schema.reviews.authorName,
        source: schema.reviews.source,
        locationName: schema.locations.name,
        organizationName: schema.organizations.name,
      })
      .from(schema.reviews)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.reviews.locationId))
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.reviews.organizationId))
      /*
      The source must still be connected.

      An inner join rather than letting `postReply` throw "no longer
      connected": that throw is correct for a person pressing Post, and wrong
      here. A branch that disconnected Google still has its old five-star
      reviews, so every sweep would try them all, fail them all, and write a
      warning per review per hour, for ever. Not being a candidate is the
      honest description of a review nobody can reply to.
    */
      .innerJoin(
        schema.connections,
        and(
          eq(schema.connections.locationId, schema.reviews.locationId),
          eq(schema.connections.provider, schema.reviews.source),
        ),
      )
      .leftJoin(
        schema.replies,
        and(
          eq(schema.replies.reviewId, schema.reviews.id),
          sql`${schema.replies.status} <> 'failed'`,
        ),
      )
      .where(
        and(
          eq(schema.reviews.organizationId, rule.organizationId),
          eq(schema.reviews.locationId, rule.locationId),
          eq(schema.reviews.rating, AUTO_REPLY_RATING),
          // No words at all. `''` and whitespace count as none: a platform that
          // stores an empty string is not a review with something in it.
          sql`(${schema.reviews.text} is null or length(trim(${schema.reviews.text})) = 0)`,
          // The owner answered it on the platform. `reviews.owner_replied_at` is
          // the *only* place this is asked, per W1.2.
          isNull(schema.reviews.ownerRepliedAt),
          // We have not started one either.
          isNull(schema.replies.id),
          /*
          A DM is private and can never be answered publicly.

          Belt and braces, and the braces are the database: the
          `reviews_rating_only_on_reviews` check constraint refuses a rating on
          a DM outright, so a five-star DM cannot exist to be matched. Kept
          because this clause states the intent at the place somebody would
          come to loosen the rating condition.
        */
          sql`${schema.reviews.itemType} <> 'dm'`,
          lte(schema.reviews.postedAt, cutoff),
        ),
      )
      .orderBy(schema.reviews.postedAt)
      .limit(limit)
  );
}

/**
 * Runs one location's rule.
 *
 * Each review is its own transaction. A batch that aborted half way through
 * would leave replies posted on the platform and no rows saying so, which is
 * the one inconsistency that cannot be repaired from our side — the platform
 * has the reply and we would try again.
 */
export async function runAutoReply(
  rule: AutoReplyRule,
  now = new Date(),
): Promise<AutoReplyOutcome> {
  const outcome: AutoReplyOutcome = { posted: 0, failed: 0, unpostable: 0 };

  const [template, candidates] = await withTenant(
    { organizationId: rule.organizationId },
    async (tx) => [await loadTemplate(tx, rule), await autoReplyCandidates(tx, rule, now)] as const,
  );

  // The template was deleted between the sweep reading the rule and this
  // running. `ON DELETE SET NULL` normally turns the rule off; this covers the
  // race, and does it by doing nothing.
  if (!template) return outcome;

  for (const candidate of candidates) {
    const connector = getConnector(candidate.source);
    if (connector.capabilities.reply !== "api" || !connector.postReply) {
      // Counted, not logged per review: a business whose only source cannot
      // take API replies would otherwise fill the log every sweep.
      outcome.unpostable += 1;
      continue;
    }

    try {
      await withTenant({ organizationId: rule.organizationId }, async (tx) => {
        const text = renderAutoReply(template, candidate);

        const draft = await writeReplyDraft({
          tx,
          organizationId: rule.organizationId,
          // Nobody typed it. `replies.author_user_id` is nullable for exactly
          // this, and a placeholder id would make the audit trail lie about
          // who wrote the words on a customer's screen.
          actorUserId: null,
          reviewId: candidate.reviewId,
          text,
        });

        await approveAndPost(tx, rule.organizationId, draft);
      });

      outcome.posted += 1;
    } catch (error) {
      outcome.failed += 1;
      log.warn(
        { err: error, reviewId: candidate.reviewId, locationId: rule.locationId },
        "Auto-reply failed",
      );
    }
  }

  if (outcome.posted > 0 || outcome.failed > 0) {
    log.info({ ...outcome, locationId: rule.locationId }, "Auto-reply run");
  }

  return outcome;
}

async function approveAndPost(
  tx: TenantDatabase,
  organizationId: string,
  draft: ReplyRow,
): Promise<void> {
  // Both steps still happen, in order, through the same functions a person's
  // reply goes through — so the state machine, the row locking and the audit
  // trail are the ones that have always been there. What is different is the
  // actor, and it is null rather than borrowed.
  await approveReply({ tx, organizationId, actorUserId: null, replyId: draft.id });
  const result = await postReply({ tx, organizationId, actorUserId: null, replyId: draft.id });
  if (!result.ok) throw new Error(result.reason);
}

/** The rule's template, with the branch's signature already resolved. */
async function loadTemplate(
  tx: TenantDatabase,
  rule: AutoReplyRule,
): Promise<{ body: string; signature: string | null } | null> {
  const [row] = await tx
    .select({
      body: schema.replyTemplates.body,
      signature: schema.locations.replySignature,
    })
    .from(schema.replyTemplates)
    .innerJoin(schema.locations, eq(schema.locations.id, rule.locationId))
    .where(
      and(
        eq(schema.replyTemplates.organizationId, rule.organizationId),
        eq(schema.replyTemplates.id, rule.templateId),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * The words that will be posted.
 *
 * Exported and pure so the settings screen can show the business exactly what
 * this rule would say before they switch it on. A rule whose output you cannot
 * read before enabling it is a rule nobody should enable.
 */
export function renderAutoReply(
  template: { body: string; signature: string | null },
  context: { authorName: string | null; locationName: string; organizationName: string },
): string {
  const filled = renderTemplate(template.body, {
    author: context.authorName,
    location: context.locationName,
    business: context.organizationName,
  });

  return appendSignature(filled, template.signature);
}
