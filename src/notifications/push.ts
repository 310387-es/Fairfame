import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import webpush from "web-push";
import { schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { dashboardUrl } from "../lib/urls.ts";
import { withTenant, type TenantDatabase } from "../lib/tenancy.ts";
import type { ReviewNotificationPayload, SlaRollupPayload } from "./service.ts";

/**
 * Web Push (W5-9).
 *
 * The half of "PWA + push" that a manifest cannot do: a notification that
 * arrives when the tab is closed, which for a café owner standing behind a
 * counter is the only kind that matters.
 *
 * ## It rides the notification rows rather than replacing them
 *
 * There is no separate "should this be pushed" decision. A push goes to
 * whatever already produced a `notifications` row — so `scope: negative_only`,
 * `scope: off`, the assignment rules, the SLA rollup threshold and **quiet
 * hours** all apply without being re-implemented, and a preference somebody
 * sets once means the same thing on their phone as in their inbox.
 *
 * `sendPendingPush` therefore reads the same `send_after` predicate the email
 * sender does. That is the single most important line in this file: the whole
 * point of W5-15 was that a phone should not buzz at 03:40, and a push channel
 * that ignored it would have quietly undone the feature two commits later.
 *
 * ## The failure that matters is `410`
 *
 * A push endpoint dies silently — the browser is uninstalled, the profile is
 * cleared, the subscription is rotated — and the *only* reliable signal is a
 * `404`/`410` from the push service. A row not pruned on that response is a row
 * that fails for ever, so those two statuses delete rather than log. Anything
 * else is a transient failure and is left alone.
 */

const log = childLogger({ module: "notifications/push" });

/** How many devices one drain answers. Bounded like every other sender here. */
const PUSH_BATCH = 200;

export type PushConfig = { publicKey: string; privateKey: string; subject: string };

/**
 * The VAPID identity, or null when this deployment has none.
 *
 * Null is the ordinary state today and it is not an error: push needs a key
 * pair somebody generated and put in the environment, exactly as the token
 * vault does, and a deployment without one simply does not offer the button.
 * Failing at boot would take the whole app down over an optional channel.
 */
export function pushConfig(): PushConfig | null {
  const env = getEnv();
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;

  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: vapidSubject(env.VAPID_SUBJECT, dashboardUrl("/")),
  };
}

/**
 * The contact a push service is entitled to have for the *application*.
 *
 * The spec allows exactly two forms — `https:` and `mailto:` — and `web-push`
 * enforces it by throwing. Defaulting to this deployment's own origin is the
 * honest answer until a support address exists, and it is **wrong on every
 * http origin**, which is every development machine: `setVapidDetails` threw
 * `Vapid subject is not an https: or mailto: URL`, the drain's guard caught it,
 * and the DB suite quietly logged "Push drain failed" on every run.
 *
 * So an unusable origin falls back to a `mailto:` on the origin's own host. It
 * is not a real inbox and does not pretend to be — it is a syntactically valid
 * contact that lets the local path work, and a deployment that wants to be
 * reachable sets `VAPID_SUBJECT`.
 */
export function vapidSubject(configured: string | undefined, origin: string): string {
  const candidate = configured ?? origin;
  if (candidate.startsWith("mailto:") || candidate.startsWith("https://")) return candidate;

  const host = safeHost(candidate) ?? "localhost";
  return `mailto:push@${host}`;
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Records a device.
 *
 * Upserts on the endpoint, because a browser re-subscribing after a restart
 * hands back the same one — and a row per restart is how a table of dead
 * endpoints accumulates.
 */
export async function saveSubscription(
  tx: TenantDatabase,
  input: { organizationId: string; userId: string; subscription: PushSubscriptionInput },
): Promise<void> {
  await tx
    .insert(schema.pushSubscriptions)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: {
        // The owner too: a shared device that changes hands must stop
        // delivering the previous person's alerts.
        organizationId: input.organizationId,
        userId: input.userId,
        p256dh: input.subscription.keys.p256dh,
        auth: input.subscription.keys.auth,
        updatedAt: new Date(),
      },
    });
}

/** Forgets a device. Idempotent: unsubscribing twice is not an error. */
export async function removeSubscription(
  tx: TenantDatabase,
  organizationId: string,
  endpoint: string,
): Promise<void> {
  await tx
    .delete(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.organizationId, organizationId),
        eq(schema.pushSubscriptions.endpoint, endpoint),
      ),
    );
}

export type PushResult = { sent: number; failed: number; pruned: number };

/**
 * What a notification says on a lock screen.
 *
 * Deliberately short and deliberately **not** the review's full text. A lock
 * screen is readable by whoever is standing next to the phone, and a one-star
 * review naming a member of staff is not something to put there in full.
 */
export type PushMessage = { title: string; body: string; url: string; tag: string };

export function pushMessageFor(row: {
  id: string;
  type: string;
  payload: unknown;
  organizationName: string;
}): PushMessage | null {
  const payload = row.payload as Partial<ReviewNotificationPayload & SlaRollupPayload>;

  if (row.type === "sla_rollup" || row.type === "assignment_rollup") {
    if (typeof payload.count !== "number") return null;
    return {
      title: row.organizationName,
      body: `${payload.count} · ${payload.locationName ?? ""}`.trim(),
      url: dashboardUrl("/reviews?reply=unanswered"),
      tag: `rollup-${row.id}`,
    };
  }

  if (!payload.reviewId) return null;

  const stars = typeof payload.rating === "number" ? "★".repeat(payload.rating) : "";
  return {
    title: [payload.authorName ?? row.organizationName, stars].filter(Boolean).join(" "),
    // The excerpt the feed already stores, not the whole review. See above.
    body: payload.excerpt ?? "",
    url: dashboardUrl(`/reviews?review=${payload.reviewId}`),
    tag: `review-${payload.reviewId}`,
  };
}

/**
 * Pushes every notification that is due and has a device to go to.
 *
 * The `send_after` clause is the same one `sendPendingEmails` applies, and it
 * is why quiet hours work here without being written twice.
 */
export async function sendPendingPush(options: {
  organizationId: string;
  limit?: number;
  now?: Date;
}): Promise<PushResult> {
  const { organizationId, limit = PUSH_BATCH, now = new Date() } = options;
  const result: PushResult = { sent: 0, failed: 0, pruned: 0 };

  const config = pushConfig();
  if (!config) return result;

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const rows = await withTenant({ organizationId }, (tx) =>
    tx
      .select({
        id: schema.notifications.id,
        userId: schema.notifications.userId,
        type: schema.notifications.type,
        payload: schema.notifications.payload,
        organizationName: schema.organizations.name,
        endpoint: schema.pushSubscriptions.endpoint,
        p256dh: schema.pushSubscriptions.p256dh,
        auth: schema.pushSubscriptions.auth,
      })
      .from(schema.notifications)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.notifications.organizationId),
      )
      // Inner join: a notification with no device is not a failure, it is a
      // person who has not turned this on. Nothing is recorded about it.
      .innerJoin(
        schema.pushSubscriptions,
        and(
          eq(schema.pushSubscriptions.userId, schema.notifications.userId),
          eq(schema.pushSubscriptions.organizationId, schema.notifications.organizationId),
        ),
      )
      .where(
        and(
          eq(schema.notifications.organizationId, organizationId),
          isNull(schema.notifications.pushedAt),
          isNull(schema.notifications.readAt),
          // Quiet hours, from W5-15. The same predicate the email sender uses;
          // duplicating the *column* is fine, duplicating the *rule* would not
          // be — a push channel that ignored a quiet window would have undone
          // that feature two commits after it shipped.
          or(isNull(schema.notifications.sendAfter), lte(schema.notifications.sendAfter, now)),
          // Nothing older than a day. A notification nobody has read from
          // Tuesday is not news on Thursday, and buzzing a phone about it is
          // how somebody turns this off for good.
          sql`${schema.notifications.createdAt} > ${new Date(now.getTime() - 24 * 60 * 60 * 1_000)}`,
        ),
      )
      .limit(limit),
  );

  if (rows.length === 0) return result;

  const delivered: string[] = [];
  const deadEndpoints: string[] = [];

  for (const row of rows) {
    const message = pushMessageFor(row);
    if (!message) continue;

    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(message),
        { TTL: 60 * 60 },
      );
      delivered.push(row.id);
      result.sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;

      // 404/410 is the only reliable "this device is gone" — a browser
      // uninstalled, a profile cleared, a subscription rotated. Anything else
      // is transient and the row is left for the next drain.
      if (status === 404 || status === 410) {
        deadEndpoints.push(row.endpoint);
        result.pruned += 1;
      } else {
        result.failed += 1;
        log.warn({ status, err: error }, "Push failed");
      }
    }
  }

  await withTenant({ organizationId }, async (tx) => {
    if (delivered.length > 0) {
      await tx
        .update(schema.notifications)
        .set({ pushedAt: now })
        .where(inArray(schema.notifications.id, delivered));

      await tx
        .update(schema.pushSubscriptions)
        .set({ lastSentAt: now })
        .where(eq(schema.pushSubscriptions.organizationId, organizationId));
    }

    if (deadEndpoints.length > 0) {
      await tx
        .delete(schema.pushSubscriptions)
        .where(inArray(schema.pushSubscriptions.endpoint, deadEndpoints));
    }
  });

  if (result.sent > 0 || result.pruned > 0) log.info({ organizationId, ...result }, "Push drained");
  return result;
}
