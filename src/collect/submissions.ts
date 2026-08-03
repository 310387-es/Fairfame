import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  FIRST_PARTY_PROVIDER,
  firstPartyConnector,
  toRawReview,
  type FirstPartyPayload,
} from "../connectors/firstparty.ts";
import { upsertReviews } from "../connectors/normalize.ts";
import { connectSource, toConnection } from "../connectors/sync.ts";
import { schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/config.ts";
import { childLogger } from "../lib/logger.ts";
import { consumeRateLimit } from "../lib/rate-limit.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { KVKK_NOTICE_VERSION, type PublicSubmissionInput } from "./input.ts";
import { resolveCampaignBySlug, resolveRequestByToken, type PublicCampaign } from "./public.ts";
import { generateRequestToken } from "./tokens.ts";

/**
 * The public submission path: an anonymous POST becomes a canonical review.
 *
 * Two things make this safe to expose. First, the tenant is derived from the
 * campaign the slug resolves to and never from the request body, so the worst a
 * forged payload can do is write a review into the organization whose slug it
 * already had. Second, everything after that resolution runs inside
 * `withTenant()`, where RLS is the backstop.
 *
 * The review itself is built by the *connector*, not here: the payload goes
 * through `firstPartyConnector.normalize()` and `upsertReviews()`, the same two
 * steps a Google review takes. Ingestion has exactly one shape, whether the
 * source pushes or is polled.
 *
 * Note what this function never receives and never consults: the destination.
 * A submission cannot influence routing, because routing was decided when the
 * campaign was created. See ./routing.ts.
 */

const log = childLogger({ module: "collect/submissions" });

export type SubmitFailure =
  "not_found" | "closed" | "rate_limited" | "already_submitted" | "wrong_campaign";

export type SubmitResult =
  { ok: true; reviewId: string; requestId: string } | { ok: false; error: SubmitFailure };

function resolveLanguage(campaign: PublicCampaign): Locale {
  return isLocale(campaign.locale ?? undefined) ? (campaign.locale as Locale) : DEFAULT_LOCALE;
}

/** Upserts the submitter as a contact, so their email lives in exactly one place. */
async function upsertContact(
  tx: TenantDatabase,
  organizationId: string,
  input: { email: string; name: string | null; locale: Locale },
): Promise<string | null> {
  const [contact] = await tx
    .insert(schema.contacts)
    .values({
      organizationId,
      email: input.email,
      name: input.name,
      locale: input.locale,
    })
    .onConflictDoUpdate({
      target: [schema.contacts.organizationId, schema.contacts.email],
      set: { name: sql`coalesce(excluded.name, ${schema.contacts.name})`, updatedAt: new Date() },
    })
    .returning({ id: schema.contacts.id });

  return contact?.id ?? null;
}

export type SubmitContext = {
  /** Rate-limit subject. Null when the caller could not determine one. */
  ip: string | null;
};

export async function submitReview(
  input: PublicSubmissionInput,
  context: SubmitContext,
  now = new Date(),
): Promise<SubmitResult> {
  const campaign = await resolveCampaignBySlug(input.slug);
  if (!campaign) return { ok: false, error: "not_found" };
  if (campaign.status !== "active") return { ok: false, error: "closed" };

  const env = getEnv();
  const limit = await consumeRateLimit(
    // Scoped per campaign as well as per IP: a busy café's customers all share
    // a NAT address, and one venue's traffic must not throttle another's.
    `submit:${campaign.campaignId}:${context.ip ?? "unknown"}`,
    env.PUBLIC_SUBMIT_LIMIT,
    env.PUBLIC_SUBMIT_WINDOW_SECONDS,
  );
  if (!limit.allowed) return { ok: false, error: "rate_limited" };

  const request = input.requestToken ? await resolveRequestByToken(input.requestToken) : null;

  if (request) {
    // A token for another campaign is either a mistake or an attempt to graft
    // a submission onto someone else's funnel.
    if (request.campaign.campaignId !== campaign.campaignId) {
      return { ok: false, error: "wrong_campaign" };
    }
    // One ask, one review. Otherwise a leaked token is an open write endpoint.
    if (request.submittedAt !== null) return { ok: false, error: "already_submitted" };
  }

  const language = resolveLanguage(campaign);

  return withTenant({ organizationId: campaign.organizationId }, async (tx) => {
    // The connection is what carries `locationId` into normalize(); creating it
    // on demand means a campaign made before this code existed still works.
    const connectionRow = await connectSource(tx, {
      organizationId: campaign.organizationId,
      provider: FIRST_PARTY_PROVIDER,
      config: { locationId: campaign.locationId },
    });

    const contactId = input.email
      ? await upsertContact(tx, campaign.organizationId, {
          email: input.email,
          name: input.authorName,
          locale: language,
        })
      : (request?.contactId ?? null);

    const payload: FirstPartyPayload = {
      submissionId: randomUUID(),
      rating: input.rating,
      comment: input.comment,
      authorName: input.authorName,
      language,
      submittedAt: now.toISOString(),
      campaign: {
        id: campaign.campaignId,
        slug: campaign.slug,
        channel: campaign.channel,
      },
      requestId: request?.requestId ?? null,
      contactId,
      kvkkNotice: {
        version: KVKK_NOTICE_VERSION,
        shownAt: now.toISOString(),
        accepted: input.kvkkAccepted,
      },
    };

    const raw = toRawReview(payload);
    const canonical = firstPartyConnector.normalize(toConnection(connectionRow), raw);
    await upsertReviews(tx, campaign.organizationId, [canonical]);

    // upsertReviews reports counts, not ids; the submission id is freshly
    // minted so this reads back exactly the row just written.
    const [review] = await tx
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.organizationId, campaign.organizationId),
          eq(schema.reviews.source, FIRST_PARTY_PROVIDER),
          eq(schema.reviews.sourceReviewId, payload.submissionId),
        ),
      )
      .limit(1);

    if (!review) throw new Error("The submitted review could not be read back.");

    const requestId = request
      ? await closeRequest(tx, campaign.organizationId, request.requestId, {
          reviewId: review.id,
          contactId,
          now,
        })
      : await recordWalkInRequest(tx, campaign, {
          reviewId: review.id,
          contactId,
          now,
        });

    // An explicit tick, stored as evidence. This is the **KVKK** half:
    // permission to process the person's data. It is deliberately *not* an İYS
    // permission — the gate (src/compliance/gate.ts) refuses to treat it as
    // one, because agreeing to data processing on a review form is not agreeing
    // to receive marketing. An İYS opt-in needs its own tick, asking plainly.
    if (input.kvkkAccepted && contactId) {
      await tx
        .insert(schema.consentRecords)
        .values({
          organizationId: campaign.organizationId,
          contactRef: contactId,
          type: "kvkk",
          source: "web_form",
          grantedAt: now,
          proofRef: `submission:${payload.submissionId}`,
        })
        .onConflictDoUpdate({
          // The key gained `channel` in P1b-T5 so a KVKK record and per-channel
          // İYS records can coexist. A KVKK row has no channel, and the unique
          // index is NULLS NOT DISTINCT, so this still matches exactly one row.
          target: [
            schema.consentRecords.organizationId,
            schema.consentRecords.contactRef,
            schema.consentRecords.type,
            schema.consentRecords.channel,
          ],
          set: {
            grantedAt: now,
            // Re-submitting after a withdrawal is a fresh grant.
            revokedAt: null,
            source: "web_form",
            proofRef: `submission:${payload.submissionId}`,
            updatedAt: now,
          },
        });
    }

    await tx.insert(schema.auditLogs).values({
      organizationId: campaign.organizationId,
      actorUserId: null,
      action: "review.submitted",
      entity: `review:${review.id}`,
      meta: {
        source: FIRST_PARTY_PROVIDER,
        campaignId: campaign.campaignId,
        requestId,
        rating: payload.rating,
      },
    });

    log.info(
      {
        organizationId: campaign.organizationId,
        campaignId: campaign.campaignId,
        reviewId: review.id,
      },
      "First-party review submitted",
    );

    return { ok: true, reviewId: review.id, requestId };
  });
}

/** Marks the ask converted. */
async function closeRequest(
  tx: TenantDatabase,
  organizationId: string,
  requestId: string,
  args: { reviewId: string; contactId: string | null; now: Date },
): Promise<string> {
  await tx
    .update(schema.reviewRequests)
    .set({
      status: "submitted",
      submittedAt: args.now,
      // A request that converts was self-evidently opened, even if the open
      // ping never arrived (an email client that blocks redirects, a copied
      // link). Leaving it null would understate the funnel.
      openedAt: sql`coalesce(${schema.reviewRequests.openedAt}, ${args.now})`,
      reviewId: args.reviewId,
      ...(args.contactId ? { contactId: args.contactId } : {}),
      updatedAt: args.now,
    })
    .where(
      and(
        eq(schema.reviewRequests.organizationId, organizationId),
        eq(schema.reviewRequests.id, requestId),
      ),
    );

  return requestId;
}

/**
 * A QR scan or a shared link nobody was individually asked for.
 *
 * The row is created at conversion, which is why a link campaign's funnel
 * starts at "submitted": we never claimed to have sent anything, and counting
 * anonymous page views as opens would invent a denominator we cannot verify.
 */
async function recordWalkInRequest(
  tx: TenantDatabase,
  campaign: PublicCampaign,
  args: { reviewId: string; contactId: string | null; now: Date },
): Promise<string> {
  const [row] = await tx
    .insert(schema.reviewRequests)
    .values({
      organizationId: campaign.organizationId,
      campaignId: campaign.campaignId,
      locationId: campaign.locationId,
      contactId: args.contactId,
      channel: "link",
      status: "submitted",
      token: generateRequestToken(),
      submittedAt: args.now,
      reviewId: args.reviewId,
      meta: { walkIn: true },
    })
    .returning({ id: schema.reviewRequests.id });

  if (!row) throw new Error("Could not record the walk-in submission.");
  return row.id;
}
