import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { createCaptureTransport } from "@/messaging/email";
import { listFeed, markAllRead, markRead, unreadCounts } from "@/notifications/feed";
import { sendPendingEmails } from "@/notifications/email";
import { recipientsForLocation, savePreference } from "@/notifications/preferences";
import { notifyPendingReviews, upgradeUrgencyFromInsights } from "@/notifications/service";
import { withTenant } from "@/lib/tenancy";

/**
 * Notifications against a real database (P1a-T5).
 *
 * The Definition of Done is "a new mock review produces the right
 * notifications per the user's prefs; negatives are prioritized", so most of
 * this drives `notifyPendingReviews` and asserts on rows rather than on return
 * values.
 *
 * Two things get more attention than their line count suggests: **per-user
 * isolation**, because RLS does not provide it (the policy only knows the
 * organization), and **idempotency**, because every path that creates
 * notifications can run twice.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Fixture = {
  orgId: string;
  locationId: string;
  otherLocationId: string;
  ownerId: string;
  memberId: string;
};

async function makeUser(label: string, locale = "en"): Promise<string> {
  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({
      email: `${label}-${suffix}@example.test`,
      name: label,
      locale,
      emailVerified: true,
    })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("user insert returned nothing");

  userIds.push(user.id);
  return user.id;
}

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Notif ${label} ${suffix}`, slug: `notif-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} Kadıköy` },
      { organizationId: org.id, name: `${label} Beşiktaş` },
    ])
    .returning({ id: schema.locations.id });

  const ownerId = await makeUser(`${label}-owner`);
  const memberId = await makeUser(`${label}-member`);

  await getAdminDb()
    .insert(schema.memberships)
    .values([
      { organizationId: org.id, userId: ownerId, role: "owner" },
      { organizationId: org.id, userId: memberId, role: "member" },
    ]);

  return {
    orgId: org.id,
    locationId: locations[0]!.id,
    otherLocationId: locations[1]!.id,
    ownerId,
    memberId,
  };
}

let counter = 0;

async function addReview(
  fixture: Fixture,
  options: {
    rating: number | null;
    text?: string | null;
    locationId?: string;
    sentiment?: "positive" | "neutral" | "negative";
  },
): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: options.locationId ?? fixture.locationId,
      source: "mock",
      sourceReviewId: `r-${suffix}-${counter++}`,
      authorName: "Mehmet",
      rating: options.rating,
      text: options.text === undefined ? "Servis hakkında bir yorum." : options.text,
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");

  if (options.sentiment) {
    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: review.id,
        sentiment: options.sentiment,
        sentimentScore: options.sentiment === "negative" ? -0.8 : 0.8,
        topics: ["servis"],
        language: "tr",
        promptId: "test@1",
        model: "test",
      });
  }

  return review.id;
}

async function notificationsFor(orgId: string, userId?: string) {
  const rows = await getAdminDb()
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.organizationId, orgId));

  return userId ? rows.filter((row) => row.userId === userId) : rows;
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await getAdminDb().delete(schema.users).where(inArray(schema.users.id, userIds));
  await closeDatabasePools();
});

describe("creating notifications", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("create");
  });

  it("notifies every member of a new review", async () => {
    await addReview(fixture, { rating: 5, text: "Harika bir deneyimdi." });

    const result = await notifyPendingReviews({ organizationId: fixture.orgId });

    expect(result.reviews).toBe(1);
    // Two members, two notifications: the feed is per person.
    expect(result.created).toBe(2);
  });

  it("does not notify twice for the same review", async () => {
    const before = (await notificationsFor(fixture.orgId)).length;

    const result = await notifyPendingReviews({ organizationId: fixture.orgId });

    // A retried job must not produce a second alert. This is the dedupe key
    // doing its job, and the fastest way to teach someone to ignore
    // notifications is to send the same one three times.
    expect(result.created).toBe(0);
    expect((await notificationsFor(fixture.orgId)).length).toBe(before);
  });

  it("carries a snapshot of the review, not just an id", async () => {
    const rows = await notificationsFor(fixture.orgId, fixture.ownerId);
    const payload = rows[0]?.payload as Record<string, unknown>;

    // The feed must still read correctly after the review is edited or erased.
    expect(payload.locationName).toContain("Kadıköy");
    expect(payload.rating).toBe(5);
    expect(payload.excerpt).toBe("Harika bir deneyimdi.");
  });
});

describe("urgency", () => {
  it("flags a low rating urgent before any analysis exists", async () => {
    const fixture = await makeFixture("stars");
    await addReview(fixture, { rating: 2, text: "Çok bekledik." });

    await notifyPendingReviews({ organizationId: fixture.orgId });

    const rows = await notificationsFor(fixture.orgId);
    // Notification must not wait for an LLM: a capped plan or a provider
    // outage would otherwise silently mute alerts.
    expect(rows.every((row) => row.urgency === "urgent")).toBe(true);
  });

  it("flags a five-star review urgent when the model reads it as negative", async () => {
    const fixture = await makeFixture("sentiment");
    await addReview(fixture, {
      rating: 5,
      text: "Harika, bir saat beklemeyi seviyorsanız.",
      sentiment: "negative",
    });

    await notifyPendingReviews({ organizationId: fixture.orgId });

    const rows = await notificationsFor(fixture.orgId);
    expect(rows.every((row) => row.urgency === "urgent")).toBe(true);
  });

  it("leaves a genuinely positive review as normal", async () => {
    const fixture = await makeFixture("positive");
    await addReview(fixture, { rating: 5, text: "Mükemmeldi.", sentiment: "positive" });

    await notifyPendingReviews({ organizationId: fixture.orgId });

    const rows = await notificationsFor(fixture.orgId);
    expect(rows.every((row) => row.urgency === "normal")).toBe(true);
  });

  it("upgrades an unread notification when analysis later finds it negative", async () => {
    const fixture = await makeFixture("upgrade");
    const reviewId = await addReview(fixture, { rating: 4, text: "İdare eder ama pahalı." });

    await notifyPendingReviews({ organizationId: fixture.orgId });
    expect((await notificationsFor(fixture.orgId)).every((r) => r.urgency === "normal")).toBe(true);

    // Analysis arrives after the alert — the ordinary case, since notification
    // deliberately does not wait for it.
    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId,
        sentiment: "negative",
        sentimentScore: -0.6,
        topics: ["fiyat"],
        language: "tr",
        promptId: "test@1",
        model: "test",
      });

    const upgraded = await upgradeUrgencyFromInsights({ organizationId: fixture.orgId });

    expect(upgraded).toBe(2);
    expect((await notificationsFor(fixture.orgId)).every((r) => r.urgency === "urgent")).toBe(true);
  });

  it("leaves a read notification alone", async () => {
    const fixture = await makeFixture("read-upgrade");
    const reviewId = await addReview(fixture, { rating: 4, text: "Fena değil." });

    await notifyPendingReviews({ organizationId: fixture.orgId });

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      markAllRead(tx, fixture.orgId, fixture.ownerId),
    );

    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId,
        sentiment: "negative",
        sentimentScore: -0.5,
        topics: ["servis"],
        language: "tr",
        promptId: "test@1",
        model: "test",
      });

    await upgradeUrgencyFromInsights({ organizationId: fixture.orgId });

    const owner = await notificationsFor(fixture.orgId, fixture.ownerId);
    const member = await notificationsFor(fixture.orgId, fixture.memberId);

    // Re-flagging something already read would push it back to the top of the
    // feed for a fact the user has already acted on.
    expect(owner[0]?.urgency).toBe("normal");
    expect(member[0]?.urgency).toBe("urgent");
  });
});

describe("preferences", () => {
  it("sends nothing to a user who turned notifications off", async () => {
    const fixture = await makeFixture("off");

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.memberId,
        locationId: null,
        scope: "off",
        delivery: "instant",
        inApp: true,
        email: true,
      }),
    );

    await addReview(fixture, { rating: 1, text: "Berbat." });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    expect(await notificationsFor(fixture.orgId, fixture.memberId)).toHaveLength(0);
    expect(await notificationsFor(fixture.orgId, fixture.ownerId)).toHaveLength(1);
  });

  it("sends only negatives to a negative-only user", async () => {
    const fixture = await makeFixture("negonly");

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.memberId,
        locationId: null,
        scope: "negative_only",
        delivery: "instant",
        inApp: true,
        email: true,
      }),
    );

    await addReview(fixture, { rating: 5, text: "Çok iyi." });
    await addReview(fixture, { rating: 1, text: "Çok kötü." });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const member = await notificationsFor(fixture.orgId, fixture.memberId);
    const owner = await notificationsFor(fixture.orgId, fixture.ownerId);

    expect(member).toHaveLength(1);
    expect(member[0]?.urgency).toBe("urgent");
    expect(owner).toHaveLength(2);
  });

  it("lets a location override beat the organization default", async () => {
    const fixture = await makeFixture("override");

    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.memberId,
        locationId: null,
        scope: "off",
        delivery: "instant",
        inApp: true,
        email: true,
      });
      await savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.memberId,
        locationId: fixture.locationId,
        scope: "all",
        delivery: "instant",
        inApp: true,
        email: true,
      });
    });

    await addReview(fixture, { rating: 5, locationId: fixture.locationId });
    await addReview(fixture, { rating: 5, locationId: fixture.otherLocationId });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const member = await notificationsFor(fixture.orgId, fixture.memberId);

    // Most specific wins: on for this location, off everywhere else.
    expect(member).toHaveLength(1);
    expect(member[0]?.locationId).toBe(fixture.locationId);
  });

  it("keeps one default row per user however often it is saved", async () => {
    const fixture = await makeFixture("upsert");

    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      for (const scope of ["all", "negative_only", "off"] as const) {
        await savePreference(tx, {
          organizationId: fixture.orgId,
          userId: fixture.ownerId,
          locationId: null,
          scope,
          delivery: "instant",
          inApp: true,
          email: true,
        });
      }
    });

    const rows = await getAdminDb()
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, fixture.ownerId));

    // NULLS NOT DISTINCT on the unique key. Without it Postgres treats every
    // null location_id as distinct and this would be three rows.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe("off");
  });

  it("does not notify a client-role member by default", async () => {
    const fixture = await makeFixture("client");
    const clientId = await makeUser(`client-${suffix}`);

    await getAdminDb()
      .insert(schema.memberships)
      .values({ organizationId: fixture.orgId, userId: clientId, role: "client" });

    await addReview(fixture, { rating: 4 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    // Mailing an outside party every review is a disclosure decision the
    // organization has not made. They can still be opted in explicitly.
    expect(await notificationsFor(fixture.orgId, clientId)).toHaveLength(0);
    expect(await notificationsFor(fixture.orgId, fixture.ownerId)).toHaveLength(1);
  });

  it("notifies a client who has been opted in explicitly", async () => {
    const fixture = await makeFixture("client-optin");
    const clientId = await makeUser(`client-in-${suffix}`);

    await getAdminDb()
      .insert(schema.memberships)
      .values({ organizationId: fixture.orgId, userId: clientId, role: "client" });

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: clientId,
        locationId: null,
        scope: "all",
        delivery: "instant",
        inApp: true,
        email: true,
      }),
    );

    await addReview(fixture, { rating: 4 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    expect(await notificationsFor(fixture.orgId, clientId)).toHaveLength(1);
  });

  it("resolves every member in one pass", async () => {
    const fixture = await makeFixture("resolve");

    const recipients = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      recipientsForLocation(tx, fixture.orgId, fixture.locationId),
    );

    expect(recipients).toHaveLength(2);
    expect(recipients.every((r) => r.preference.scope === "all")).toBe(true);
  });
});

describe("email", () => {
  it("sends instantly and records that it did", async () => {
    const fixture = await makeFixture("mail");
    await addReview(fixture, { rating: 2, text: "Yavaş servis." });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const transport = createCaptureTransport();
    const result = await sendPendingEmails({ organizationId: fixture.orgId, transport });

    expect(result.sent).toBe(2);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]?.subject).toMatch(/Heads up/);

    const rows = await notificationsFor(fixture.orgId);
    expect(rows.every((row) => row.emailStatus === "sent")).toBe(true);
    expect(rows.every((row) => row.emailedAt !== null)).toBe(true);
  });

  it("sends nothing twice", async () => {
    const fixture = await makeFixture("mail-once");
    await addReview(fixture, { rating: 5 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const transport = createCaptureTransport();
    await sendPendingEmails({ organizationId: fixture.orgId, transport });
    const second = await sendPendingEmails({ organizationId: fixture.orgId, transport });

    expect(second.sent).toBe(0);
  });

  it("holds the email for a digest user but still writes the feed row", async () => {
    const fixture = await makeFixture("digest");

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.memberId,
        locationId: null,
        scope: "all",
        delivery: "digest",
        inApp: true,
        email: true,
      }),
    );

    await addReview(fixture, { rating: 5 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const transport = createCaptureTransport();
    await sendPendingEmails({ organizationId: fixture.orgId, transport });

    const member = await notificationsFor(fixture.orgId, fixture.memberId);
    expect(member).toHaveLength(1);
    expect(member[0]?.emailStatus).toBe("deferred");
    // One email, to the owner, not to the digest user.
    expect(transport.sent).toHaveLength(1);
  });

  it("records `skipped` when the user wants in-app only", async () => {
    const fixture = await makeFixture("inapp-only");

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      savePreference(tx, {
        organizationId: fixture.orgId,
        userId: fixture.memberId,
        locationId: null,
        scope: "all",
        delivery: "instant",
        inApp: true,
        email: false,
      }),
    );

    await addReview(fixture, { rating: 5 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const member = await notificationsFor(fixture.orgId, fixture.memberId);
    // Distinct from `deferred`, so "why no email?" has one answer per row.
    expect(member[0]?.emailStatus).toBe("skipped");
  });

  it("writes the email in the recipient's language, not the reviewer's", async () => {
    const fixture = await makeFixture("locale");

    await getAdminDb()
      .update(schema.users)
      .set({ locale: "tr" })
      .where(eq(schema.users.id, fixture.ownerId));

    // A Turkish-speaking owner reading an English review still wants Turkish.
    await addReview(fixture, { rating: 1, text: "The service was terrible." });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const transport = createCaptureTransport();
    await sendPendingEmails({ organizationId: fixture.orgId, transport });

    const owner = transport.sent.find((message) => message.to.includes("locale-owner"));
    expect(owner?.subject).toMatch(/Dikkat/);
  });

  it("marks a failed send failed rather than leaving it pending forever", async () => {
    const fixture = await makeFixture("mail-fail");
    await addReview(fixture, { rating: 3 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const failing = {
      name: "failing",
      async send() {
        return { ok: false as const, reason: "no such mailbox", retryable: false };
      },
    };

    const result = await sendPendingEmails({ organizationId: fixture.orgId, transport: failing });

    expect(result.failed).toBe(2);
    const rows = await notificationsFor(fixture.orgId);
    expect(rows.every((row) => row.emailStatus === "failed")).toBe(true);
  });
});

describe("the feed", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("feed");
    await addReview(fixture, { rating: 5, text: "Güzeldi." });
    await addReview(fixture, { rating: 1, text: "Kötüydü." });
    await notifyPendingReviews({ organizationId: fixture.orgId });
  });

  it("puts urgent items first, whatever their age", async () => {
    const items = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listFeed(tx, fixture.orgId, fixture.ownerId),
    );

    // "Negatives are prioritized", from the Definition of Done. Pure recency
    // would bury a 1-star under any later 5-star.
    expect(items[0]?.urgency).toBe("urgent");
    expect(items).toHaveLength(2);
  });

  it("counts unread and urgent separately", async () => {
    const counts = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      unreadCounts(tx, fixture.orgId, fixture.ownerId),
    );

    expect(counts).toEqual({ total: 2, urgent: 1 });
  });

  it("marks one read without touching the rest", async () => {
    const items = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listFeed(tx, fixture.orgId, fixture.ownerId),
    );

    const marked = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      markRead(tx, fixture.orgId, fixture.ownerId, [items[0]!.id]),
    );

    expect(marked).toBe(1);

    const counts = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      unreadCounts(tx, fixture.orgId, fixture.ownerId),
    );
    expect(counts.total).toBe(1);
  });

  it("filters to unread when asked", async () => {
    const items = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listFeed(tx, fixture.orgId, fixture.ownerId, { unreadOnly: true }),
    );

    expect(items).toHaveLength(1);
    expect(items.every((item) => item.readAt === null)).toBe(true);
  });
});

describe("isolation", () => {
  it("never shows one member another member's feed", async () => {
    const fixture = await makeFixture("peek");
    await addReview(fixture, { rating: 5 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const owner = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listFeed(tx, fixture.orgId, fixture.ownerId),
    );
    const member = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listFeed(tx, fixture.orgId, fixture.memberId),
    );

    // Both are in the same organization, so RLS permits both rows. The user
    // filter in the data layer is the only thing keeping these apart.
    expect(owner).toHaveLength(1);
    expect(member).toHaveLength(1);
    expect(owner[0]?.id).not.toBe(member[0]?.id);
  });

  it("cannot mark another member's notification read", async () => {
    const fixture = await makeFixture("cross-read");
    await addReview(fixture, { rating: 5 });
    await notifyPendingReviews({ organizationId: fixture.orgId });

    const memberItems = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listFeed(tx, fixture.orgId, fixture.memberId),
    );

    const marked = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      markRead(tx, fixture.orgId, fixture.ownerId, [memberItems[0]!.id]),
    );

    expect(marked).toBe(0);

    const counts = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      unreadCounts(tx, fixture.orgId, fixture.memberId),
    );
    expect(counts.total).toBe(1);
  });

  it("never notifies another organization's members", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");

    await addReview(mine, { rating: 1 });
    await notifyPendingReviews({ organizationId: mine.orgId });

    expect((await notificationsFor(mine.orgId)).length).toBe(2);
    expect(await notificationsFor(theirs.orgId)).toHaveLength(0);
  });
});
