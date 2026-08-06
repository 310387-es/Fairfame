import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { pinnedReviewsHref } from "../reviews/filters.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import { dashboardUrl } from "../lib/urls.ts";
import { getEmailTransport, type EmailTransport } from "../messaging/email.ts";
import { renderDigestEmail } from "../messaging/templates.ts";
import { recipientsForLocation } from "../notifications/preferences.ts";
import type { DigestPayload } from "./pipeline.ts";

/**
 * Delivering the digest (D1 — docs/14-digest-surfaces.md).
 *
 * The pipeline composes a digest and stops. Until this existed, `digest_sweep`
 * spent model tokens every week on a briefing that nothing rendered and nobody
 * received — and worse, anyone who had chosen `delivery: "digest"` in their
 * notification preferences got *no email at all*, because the new-review sender
 * marks those rows `deferred` and this is the consumer that was missing.
 *
 * Two rules shape the whole module:
 *
 *   1. **Sending is idempotent.** The sweep runs hourly and is allowed to
 *      re-run, so "already delivered" is a row in `digest_deliveries`, never an
 *      assumption about how often the job fired.
 *   2. **The ledger is per recipient.** Three delivered and two bounced is a
 *      real outcome; a retry must re-send to the two and leave the three alone.
 *
 * Reads and writes bracket the send rather than wrapping it, exactly as
 * `notifications/email.ts` does: an open transaction held across an SMTP call
 * is a lock waiting on a network timeout.
 */

const log = childLogger({ module: "digest/delivery" });

/** Digests handled per run. A week's worth for one organization is far fewer. */
const DEFAULT_LIMIT = 50;

export type DigestDeliveryResult = {
  sent: number;
  failed: number;
  /** Recipients skipped because the ledger already had them. */
  skipped: number;
  /** Deferred new-review notifications folded into a digest and closed out. */
  held: number;
};

function localeOf(value: string | null): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

type Candidate = {
  digestId: string;
  locationId: string;
  locationName: string;
  organizationName: string;
  periodStart: Date;
  periodEnd: Date;
  pulseScore: number | null;
  pulseDelta: number | null;
  reviewCount: number;
  payload: DigestPayload | null;
};

/**
 * Ready digests for the window, newest first.
 *
 * `ready` only, for the same reason Home reads only ready rows: a pending
 * digest is a job in flight and a failed one is an incident, and mailing either
 * as "your week" is worse than mailing nothing.
 */
async function candidates(
  tx: TenantDatabase,
  organizationId: string,
  periodStart: Date | undefined,
  limit: number,
): Promise<Candidate[]> {
  const rows = await tx
    .select({
      digestId: schema.digests.id,
      locationId: schema.digests.locationId,
      locationName: schema.locations.name,
      organizationName: schema.organizations.name,
      periodStart: schema.digests.periodStart,
      periodEnd: schema.digests.periodEnd,
      pulseScore: schema.digests.pulseScore,
      pulseDelta: schema.digests.pulseDelta,
      reviewCount: schema.digests.reviewCount,
      payload: schema.digests.payload,
    })
    .from(schema.digests)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.digests.locationId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.digests.organizationId))
    .where(
      and(
        eq(schema.digests.organizationId, organizationId),
        eq(schema.digests.status, "ready"),
        periodStart ? eq(schema.digests.periodStart, periodStart) : undefined,
      ),
    )
    .orderBy(asc(schema.digests.periodStart))
    .limit(limit);

  return rows.map((row) => ({ ...row, payload: (row.payload as DigestPayload | null) ?? null }));
}

/**
 * New-review alerts this person asked us to hold, for one location and window.
 *
 * Returned as ids rather than a count because they are also what gets closed
 * out: once the digest carrying them is sent, they stop being deferred. Leaving
 * them would mean next week's digest counted them a second time.
 */
async function heldNotifications(
  tx: TenantDatabase,
  organizationId: string,
  userId: string,
  locationId: string,
  window: { start: Date; end: Date },
): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.organizationId, organizationId),
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.locationId, locationId),
        eq(schema.notifications.emailStatus, "deferred"),
        gte(schema.notifications.createdAt, window.start),
        lt(schema.notifications.createdAt, window.end),
      ),
    );

  return rows.map((row) => row.id);
}

/**
 * Sends every digest this organization owes, for one window or all of them.
 *
 * Returns counts rather than rows: the caller is a job, and the question worth
 * answering is whether anything moved.
 */
export async function sendDigestEmails(options: {
  organizationId: string;
  /** Restrict to one window. Omitted, every ready digest is considered. */
  periodStart?: Date;
  limit?: number;
  transport?: EmailTransport;
  now?: Date;
}): Promise<DigestDeliveryResult> {
  const { organizationId, periodStart, limit = DEFAULT_LIMIT, now = new Date() } = options;
  const transport = options.transport ?? getEmailTransport();
  const result: DigestDeliveryResult = { sent: 0, failed: 0, skipped: 0, held: 0 };

  type Outbound = {
    digestId: string;
    userId: string;
    email: string;
    subject: string;
    text: string;
    html: string;
    heldIds: string[];
  };

  const outbound = await withTenant({ organizationId }, async (tx): Promise<Outbound[]> => {
    const digests = await candidates(tx, organizationId, periodStart, limit);
    if (digests.length === 0) return [];

    // One lookup for the whole batch: the ledger is the idempotency check and
    // it must not become a query per recipient.
    const delivered = await tx
      .select({
        digestId: schema.digestDeliveries.digestId,
        userId: schema.digestDeliveries.userId,
      })
      .from(schema.digestDeliveries)
      .where(
        and(
          eq(schema.digestDeliveries.organizationId, organizationId),
          eq(schema.digestDeliveries.channel, "email"),
          // A failed row is not "delivered" — it is exactly what a retry is
          // for. Only `sent` closes a recipient out.
          eq(schema.digestDeliveries.status, "sent"),
          inArray(
            schema.digestDeliveries.digestId,
            digests.map((digest) => digest.digestId),
          ),
        ),
      );

    const done = new Set(delivered.map((row) => `${row.digestId}:${row.userId}`));

    // The three recommendations live in their own table, because they have a
    // life after publication — an owner marks one done and next week's digest
    // reads that. One batched read rather than one per digest.
    const actionRows = await tx
      .select({
        digestId: schema.digestActions.digestId,
        position: schema.digestActions.position,
        text: schema.digestActions.text,
        // The citations W1.6 stores, so the email can carry a customer's own
        // words and link to the reviews rather than asking to be believed.
        evidence: schema.digestActions.evidence,
      })
      .from(schema.digestActions)
      .where(
        and(
          eq(schema.digestActions.organizationId, organizationId),
          inArray(
            schema.digestActions.digestId,
            digests.map((digest) => digest.digestId),
          ),
        ),
      )
      .orderBy(asc(schema.digestActions.position));

    type ActionRow = { position: number; text: string; reviewIds: string[] };
    const actionsByDigest = new Map<string, ActionRow[]>();
    for (const row of actionRows) {
      const existing = actionsByDigest.get(row.digestId);
      // `evidence` is jsonb, so its shape is whatever was written — including by
      // a revision that predates `reviewIds`. Read defensively rather than
      // asserting: a malformed blob must cost the citation, not the email.
      const evidence = row.evidence as { reviewIds?: unknown } | null;
      const reviewIds = Array.isArray(evidence?.reviewIds)
        ? evidence.reviewIds.filter((id): id is string => typeof id === "string")
        : [];
      const action = { position: row.position, text: row.text, reviewIds };
      if (existing) existing.push(action);
      else actionsByDigest.set(row.digestId, [action]);
    }

    const messages: Outbound[] = [];

    for (const digest of digests) {
      const recipients = await recipientsForLocation(tx, organizationId, digest.locationId);

      for (const recipient of recipients) {
        const { preference } = recipient;

        // Three separate opt-outs, and all of them are honoured here rather
        // than being re-derived: scope `off` wants nothing, `email: false`
        // wants the feed only, and `instant` delivery already had its email
        // when the review landed.
        if (preference.scope === "off") continue;
        if (!preference.email) continue;
        if (preference.delivery !== "digest") continue;

        if (done.has(`${digest.digestId}:${recipient.userId}`)) {
          result.skipped += 1;
          continue;
        }

        const heldIds = await heldNotifications(
          tx,
          organizationId,
          recipient.userId,
          digest.locationId,
          { start: digest.periodStart, end: digest.periodEnd },
        );

        const payload = digest.payload;

        /**
         * Every quoted review the payload carries, by id.
         *
         * The same source `digest-view.tsx` reads, and deliberately so: the
         * quote in the email is then guaranteed to be the text the model was
         * shown when it wrote the recommendation, rather than a fresh read that
         * could have been edited or deleted since.
         */
        const quoteById = new Map(
          (payload?.themes ?? []).flatMap((theme) =>
            theme.quotes.map((quote) => [quote.reviewId, quote] as const),
          ),
        );

        const message = renderDigestEmail({
          // The recipient's language, not the language the briefing was
          // composed in: the model wrote it in the location's locale, and a
          // team member reading it may not share that.
          locale: localeOf(recipient.locale),
          recipientName: recipient.name,
          businessName: digest.organizationName,
          locationName: digest.locationName,
          periodStart: digest.periodStart,
          periodEnd: digest.periodEnd,
          pulseScore: digest.pulseScore,
          pulseDelta: digest.pulseDelta,
          reviewCount: digest.reviewCount,
          headline: payload?.headline ?? "",
          summary: payload?.summary ?? "",
          actions: (actionsByDigest.get(digest.digestId) ?? []).map((action) => {
            const quote = action.reviewIds
              .map((id) => quoteById.get(id))
              .find((found) => found !== undefined);

            return {
              position: action.position,
              text: action.text,
              quote: quote ? { text: quote.text, rating: quote.rating } : null,
              reviewCount: action.reviewIds.length,
              // The same link the action card renders on screen, from the one
              // module that owns it. Absolute, because a mail client has no
              // origin to resolve `/reviews` against.
              link:
                action.reviewIds.length > 0
                  ? dashboardUrl(pinnedReviewsHref(digest.locationId, action.reviewIds, null))
                  : null,
            };
          }),
          themes:
            payload?.themes.map((theme) => ({
              label: theme.label,
              count: theme.count,
              positive: theme.positive,
              negative: theme.negative,
            })) ?? [],
          // From the payload, frozen at composition — see `priorOutcome` on
          // `DigestEmailInput` for why that is the right source in an email.
          priorOutcome: payload?.priorActionsOutcome
            ? {
                done: payload.priorActionsOutcome.done,
                total: payload.priorActionsOutcome.total,
              }
            : null,
          heldCount: heldIds.length,
          link: dashboardUrl(`/weekly-plan/${digest.digestId}`),
          settingsUrl: dashboardUrl("/settings#notifications"),
        });

        messages.push({
          digestId: digest.digestId,
          userId: recipient.userId,
          email: recipient.email,
          subject: message.subject,
          text: message.text,
          html: message.html,
          heldIds,
        });
      }
    }

    return messages;
  });

  if (outbound.length === 0) return result;

  const sent: Outbound[] = [];
  const failed: { message: Outbound; reason: string }[] = [];

  for (const message of outbound) {
    const outcome = await transport.send({
      to: message.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    if (outcome.ok) {
      sent.push(message);
    } else {
      failed.push({ message, reason: outcome.reason });
      log.warn(
        { organizationId, digestId: message.digestId, reason: outcome.reason },
        "Digest email failed",
      );
    }
  }

  await withTenant({ organizationId }, async (tx) => {
    const rows = [
      ...sent.map((message) => ({
        organizationId,
        digestId: message.digestId,
        userId: message.userId,
        channel: "email" as const,
        status: "sent" as const,
        error: null,
        sentAt: now,
      })),
      ...failed.map(({ message, reason }) => ({
        organizationId,
        digestId: message.digestId,
        userId: message.userId,
        channel: "email" as const,
        status: "failed" as const,
        error: reason,
        sentAt: null,
      })),
    ];

    if (rows.length > 0) {
      await tx
        .insert(schema.digestDeliveries)
        .values(rows)
        // A previous attempt that failed is updated in place. The interesting
        // question is "did this person get it", not "how many times did we
        // try", and one row per attempt would make the skip check a max().
        .onConflictDoUpdate({
          target: [
            schema.digestDeliveries.digestId,
            schema.digestDeliveries.userId,
            schema.digestDeliveries.channel,
          ],
          set: {
            status: sql`excluded.status`,
            error: sql`excluded.error`,
            sentAt: sql`excluded.sent_at`,
            updatedAt: now,
          },
        });
    }

    // Only the held notifications whose digest actually left. A failed send
    // must leave them deferred, or the retry would carry a count of zero and
    // those alerts would vanish without ever having been mailed.
    const heldIds = sent.flatMap((message) => message.heldIds);

    if (heldIds.length > 0) {
      await tx
        .update(schema.notifications)
        .set({ emailStatus: "sent", emailedAt: now, updatedAt: now })
        .where(inArray(schema.notifications.id, heldIds));

      result.held = heldIds.length;
    }
  });

  result.sent = sent.length;
  result.failed = failed.length;

  if (result.sent + result.failed > 0) {
    log.info(
      {
        organizationId,
        sent: result.sent,
        failed: result.failed,
        skipped: result.skipped,
        held: result.held,
        transport: transport.name,
      },
      "Digest emails processed",
    );
  }

  return result;
}
