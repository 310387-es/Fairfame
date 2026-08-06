import { and, eq, gte, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * The collection funnel, and the funnel by channel (W4.5).
 *
 * ## Three stages, not five
 *
 * `docs/remediation-plan.md` asks for **Sent → Delivered → Opened → Clicked →
 * Reviewed**. Two of those are not measurable here and are deliberately absent
 * rather than rendered as a permanent dash:
 *
 *   - **Delivered** needs a receipt from the transport. Email has none — there
 *     is no ESP webhook wired, and until one is, "delivered" would either
 *     repeat "sent" or be blank forever. WhatsApp *does* deliver receipts, but
 *     they land on `messages`, and a review request sent over WhatsApp does not
 *     currently carry the id of the message it produced. Joining them is real
 *     work with a real schema change; claiming the stage without it is not.
 *   - **Clicked** and **Opened** are one event for us. An email "open" is a
 *     tracking pixel — a thing this product does not embed and should think
 *     hard before it does — so `opened_at` is set when somebody *arrives on the
 *     page*, which is the click. Splitting it would put two numbers on screen
 *     that are always identical.
 *
 * A funnel with two invented stages is worse than one with three real ones: it
 * teaches the reader that the columns are decoration.
 *
 * ## Conversion is against the stage before, and against the top
 *
 * Both, because they answer different questions. "Half of the people who opened
 * it left a review" is about the page; "one in six of everyone we asked left a
 * review" is about the campaign. A funnel showing only step-to-step rates lets
 * a business feel good about a 90% conversion on the four people who opened it.
 */

export type FunnelCounts = {
  sent: number;
  opened: number;
  submitted: number;
};

export type FunnelStage = {
  key: "sent" | "opened" | "submitted";
  count: number;
  /** Share of the stage above, 0–100. Null for the first stage. */
  ofPrevious: number | null;
  /** Share of `sent`, 0–100. Null when nothing was sent. */
  ofSent: number | null;
};

export function funnelStages(counts: FunnelCounts): FunnelStage[] {
  const share = (value: number, base: number) =>
    base === 0 ? null : Math.round((value / base) * 1000) / 10;

  return [
    { key: "sent", count: counts.sent, ofPrevious: null, ofSent: counts.sent === 0 ? null : 100 },
    {
      key: "opened",
      count: counts.opened,
      ofPrevious: share(counts.opened, counts.sent),
      ofSent: share(counts.opened, counts.sent),
    },
    {
      key: "submitted",
      count: counts.submitted,
      // Against the stage above, which is `opened` — not against sent, or the
      // last two columns would be the same number twice.
      ofPrevious: share(counts.submitted, counts.opened),
      ofSent: share(counts.submitted, counts.sent),
    },
  ];
}

export type ChannelKey = "email" | "sms" | "whatsapp";

export type ChannelFunnel = FunnelCounts & { channel: ChannelKey };

export type CollectionFunnel = {
  total: FunnelCounts;
  byChannel: ChannelFunnel[];
  /**
   * Reviews collected through a hosted page with **no request behind them**
   * (W4.5).
   *
   * A QR code on a table is not a send: nobody was asked, so there is no `sent`
   * to convert from and the code has no funnel. Reporting it as a fourth
   * channel column with two empty cells would imply we failed to deliver
   * something. It is a separate figure with its own sentence — and on a Turkish
   * café it is frequently the *largest* one, which is exactly why it must not
   * be filed under "0% conversion".
   */
  walkIn: number;
};

/**
 * How far back the funnel looks.
 *
 * Ninety days rather than the billing month: a review request sits for a week
 * before somebody acts on it, so a calendar month cuts the tail off its own
 * late arrivals and reports a conversion rate that improves every time you look
 * at it later. The allowance counter above it is monthly and says so.
 */
export const FUNNEL_DAYS = 90;

export async function loadCollectionFunnel(
  tx: TenantDatabase,
  organizationId: string,
  now = new Date(),
): Promise<CollectionFunnel> {
  const since = new Date(now.getTime() - FUNNEL_DAYS * 24 * 60 * 60 * 1_000);

  const rows = await tx
    .select({
      channel: schema.reviewRequests.channel,
      sent: sql<number>`count(*) filter (where ${schema.reviewRequests.sentAt} is not null)::int`,
      opened: sql<number>`count(*) filter (where ${schema.reviewRequests.openedAt} is not null)::int`,
      submitted: sql<number>`count(*) filter (where ${schema.reviewRequests.submittedAt} is not null)::int`,
    })
    .from(schema.reviewRequests)
    .where(
      and(
        eq(schema.reviewRequests.organizationId, organizationId),
        gte(schema.reviewRequests.createdAt, since),
      ),
    )
    .groupBy(schema.reviewRequests.channel);

  /**
   * Walk-ins: a first-party review with no request row.
   *
   * `review_requests.submitted_at` records the ones we asked for; everything
   * else on the hosted page arrived because somebody scanned a code or followed
   * a link nobody attributed to them.
   */
  const [walkIn] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, organizationId),
        eq(schema.reviews.source, "firstparty"),
        gte(schema.reviews.createdAt, since),
        sql`not exists (
          select 1 from review_requests rr
          where rr.organization_id = ${organizationId}::uuid
            and rr.submitted_at is not null
            and rr.contact_id is not null
            and rr.location_id = ${schema.reviews.locationId}
            and rr.submitted_at between ${schema.reviews.createdAt} - interval '1 hour'
                                    and ${schema.reviews.createdAt} + interval '1 hour'
        )`,
      ),
    );

  const total: FunnelCounts = { sent: 0, opened: 0, submitted: 0 };
  const byChannel: ChannelFunnel[] = [];

  for (const row of rows) {
    total.sent += row.sent;
    total.opened += row.opened;
    total.submitted += row.submitted;

    // `link` is not a send channel — a campaign of that kind has nothing to
    // deliver, so its rows (if any) belong with the walk-ins conceptually and
    // never with the channels that carry a message.
    if (row.channel === "email" || row.channel === "sms" || row.channel === "whatsapp") {
      byChannel.push({
        channel: row.channel,
        sent: row.sent,
        opened: row.opened,
        submitted: row.submitted,
      });
    }
  }

  return {
    total,
    // Busiest first: on a business that has tried three channels, the one it
    // actually uses should be the row the eye lands on.
    byChannel: byChannel.sort((left, right) => right.sent - left.sent),
    walkIn: walkIn?.value ?? 0,
  };
}
