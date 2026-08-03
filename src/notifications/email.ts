import { and, asc, eq, inArray } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { getEmailTransport, type EmailTransport } from "../messaging/email.ts";
import { renderReviewAlertEmail } from "../messaging/templates.ts";
import { childLogger } from "../lib/logger.ts";
import { withTenant } from "../lib/tenancy.ts";
import { dashboardUrl } from "../lib/urls.ts";
import type { ReviewNotificationPayload } from "./service.ts";

/**
 * Sending notification emails (P1a-T5).
 *
 * Separate from ./service.ts, which decides *who* is notified. This decides
 * *when the mail leaves*, and the split matters because they fail differently:
 * creating a notification is a local write that either happens or does not,
 * while sending is a network call that can hang, bounce, or succeed slowly.
 * Binding them would mean a flaky SMTP server could lose a feed entry.
 *
 * So the row is written first with `email_status = 'pending'`, and this drains
 * the queue. A crash between the two leaves a pending row, which the next drain
 * picks up — the failure mode is a late email, never a missing notification.
 */

const log = childLogger({ module: "notifications/email" });

export type SendResult = {
  sent: number;
  failed: number;
};

function localeOf(value: string | null): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

/**
 * Sends every pending notification email for an organization.
 *
 * A send that fails is marked `failed` rather than left pending. Retrying
 * forever would mean one permanently bad address quietly consuming the sender
 * on every run; the job's own retry policy is the right place for transient
 * failures, and it has already had its attempts by the time this records a
 * verdict.
 */
export async function sendPendingEmails(options: {
  organizationId: string;
  limit?: number;
  transport?: EmailTransport;
  now?: Date;
}): Promise<SendResult> {
  const { organizationId, limit = 100, now = new Date() } = options;
  const transport = options.transport ?? getEmailTransport();
  const result: SendResult = { sent: 0, failed: 0 };

  const pending = await withTenant({ organizationId }, (tx) =>
    tx
      .select({
        id: schema.notifications.id,
        userId: schema.notifications.userId,
        urgency: schema.notifications.urgency,
        payload: schema.notifications.payload,
        email: schema.users.email,
        name: schema.users.name,
        locale: schema.users.locale,
        organizationName: schema.organizations.name,
      })
      .from(schema.notifications)
      .innerJoin(schema.users, eq(schema.users.id, schema.notifications.userId))
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.notifications.organizationId),
      )
      .where(
        and(
          eq(schema.notifications.organizationId, organizationId),
          eq(schema.notifications.emailStatus, "pending"),
        ),
      )
      // Oldest first: a backlog should clear in the order it arrived, not
      // leave the earliest alert permanently at the back of the queue.
      .orderBy(asc(schema.notifications.createdAt))
      .limit(limit),
  );

  if (pending.length === 0) return result;

  const sentIds: string[] = [];
  const failedIds: string[] = [];

  for (const row of pending) {
    const payload = row.payload as ReviewNotificationPayload;

    const message = renderReviewAlertEmail({
      // The *recipient's* language, not the reviewer's and not the browser's:
      // this email is read by a team member who may not speak the language the
      // review was written in.
      locale: localeOf(row.locale),
      recipientName: row.name,
      businessName: row.organizationName,
      locationName: payload.locationName,
      source: payload.source,
      rating: payload.rating,
      authorName: payload.authorName,
      excerpt: payload.excerpt,
      urgent: row.urgency === "urgent",
      link: dashboardUrl(`/inbox?review=${payload.reviewId}`),
      settingsUrl: dashboardUrl("/settings#notifications"),
    });

    const outcome = await transport.send({
      to: row.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    if (outcome.ok) {
      sentIds.push(row.id);
    } else {
      failedIds.push(row.id);
      log.warn(
        { organizationId, notificationId: row.id, reason: outcome.reason },
        "Notification email failed",
      );
    }
  }

  await withTenant({ organizationId }, async (tx) => {
    if (sentIds.length > 0) {
      await tx
        .update(schema.notifications)
        .set({ emailStatus: "sent", emailedAt: now, updatedAt: now })
        .where(inArray(schema.notifications.id, sentIds));
    }

    if (failedIds.length > 0) {
      await tx
        .update(schema.notifications)
        .set({ emailStatus: "failed", updatedAt: now })
        .where(inArray(schema.notifications.id, failedIds));
    }
  });

  result.sent = sentIds.length;
  result.failed = failedIds.length;

  if (result.sent + result.failed > 0) {
    log.info(
      { organizationId, sent: result.sent, failed: result.failed, transport: transport.name },
      "Notification emails processed",
    );
  }

  return result;
}
