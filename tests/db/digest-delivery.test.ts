import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { sendDigestEmails } from "@/digest/delivery";
import { savePreference } from "@/notifications/preferences";
import { createCaptureTransport, type EmailMessage, type EmailTransport } from "@/messaging/email";

/**
 * Delivering the digest, against a real database (D1 — docs/14).
 *
 * The Definition of Done is "a location with a ready digest receives one email
 * per period at most; deferred notifications for that window are marked sent
 * and appear in it; the send is idempotent under re-run; opt-out is honoured",
 * so this drives `sendDigestEmails` and asserts on rows.
 *
 * Idempotency gets the most attention, because it is the property the hourly
 * sweep depends on and the one that fails silently: an extra email is not an
 * error anywhere in the logs, it is just a business mailing its owner the same
 * briefing every hour until someone complains.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

const WINDOW = {
  start: new Date("2026-07-27T00:00:00Z"),
  end: new Date("2026-08-03T00:00:00Z"),
};

type Fixture = {
  orgId: string;
  locationId: string;
  ownerId: string;
  memberId: string;
  digestId: string;
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

/**
 * An organization with one location, two members, and a ready digest.
 *
 * Both members are given `delivery: "digest"` explicitly rather than relying on
 * the default, because the default is `instant` — a fixture that depended on it
 * would start passing for the wrong reason the day the default changed.
 */
async function makeFixture(label: string, options: { status?: "ready" | "pending" } = {}) {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Digest ${label} ${suffix}`, slug: `digest-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Kadıköy` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const ownerId = await makeUser(`${label}-owner`);
  const memberId = await makeUser(`${label}-member`);

  await getAdminDb()
    .insert(schema.memberships)
    .values([
      { organizationId: org.id, userId: ownerId, role: "owner" },
      { organizationId: org.id, userId: memberId, role: "member" },
    ]);

  const [digest] = await getAdminDb()
    .insert(schema.digests)
    .values({
      organizationId: org.id,
      locationId: location.id,
      periodStart: WINDOW.start,
      periodEnd: WINDOW.end,
      status: options.status ?? "ready",
      pulseScore: 71,
      pulseDelta: 3.5,
      reviewCount: 12,
      locale: "en",
      generatedAt: new Date("2026-08-03T02:00:00Z"),
      payload: {
        headline: "Service is holding up",
        summary: "Twelve reviews, and the queue complaints have stopped.",
        callouts: [],
        changes: [],
        themes: [
          {
            label: "Service",
            slugs: ["service"],
            count: 7,
            positive: 6,
            negative: 1,
            averageSentiment: 0.6,
            quotes: [],
          },
        ],
        assets: { replyDrafts: [], socialPost: null },
        priorActionsOutcome: null,
      },
    })
    .returning({ id: schema.digests.id });
  if (!digest) throw new Error("digest insert returned nothing");

  await getAdminDb()
    .insert(schema.digestActions)
    .values([
      {
        organizationId: org.id,
        digestId: digest.id,
        position: 1,
        text: "Reply to the two unanswered reviews.",
        evidence: { themeSlug: "service", reviewIds: [] },
      },
      {
        organizationId: org.id,
        digestId: digest.id,
        position: 2,
        text: "Thank the regulars who named Deniz.",
        evidence: { themeSlug: "service", reviewIds: [] },
      },
    ]);

  const fixture: Fixture = {
    orgId: org.id,
    locationId: location.id,
    ownerId,
    memberId,
    digestId: digest.id,
  };

  for (const userId of [ownerId, memberId]) {
    await withDefaultPreference(fixture, userId, "digest");
  }

  return fixture;
}

async function withDefaultPreference(
  fixture: Fixture,
  userId: string,
  delivery: "instant" | "digest",
  overrides: { scope?: "all" | "negative_only" | "off"; email?: boolean } = {},
): Promise<void> {
  const { withTenant } = await import("@/lib/tenancy");

  await withTenant({ organizationId: fixture.orgId }, (tx) =>
    savePreference(tx, {
      organizationId: fixture.orgId,
      userId,
      locationId: null,
      scope: overrides.scope ?? "all",
      delivery,
      inApp: true,
      email: overrides.email ?? true,
    }),
  );
}

/** A deferred new-review alert, of the kind this digest is supposed to close out. */
async function addHeldNotification(
  fixture: Fixture,
  userId: string,
  createdAt: Date,
): Promise<string> {
  const [row] = await getAdminDb()
    .insert(schema.notifications)
    .values({
      organizationId: fixture.orgId,
      userId,
      locationId: fixture.locationId,
      type: "new_review",
      urgency: "normal",
      payload: { locationName: "Kadıköy", source: "mock", rating: 4 },
      dedupeKey: `held:${crypto.randomUUID()}`,
      emailStatus: "deferred",
      createdAt,
    })
    .returning({ id: schema.notifications.id });
  if (!row) throw new Error("notification insert returned nothing");

  return row.id;
}

async function deliveriesFor(digestId: string) {
  return getAdminDb()
    .select()
    .from(schema.digestDeliveries)
    .where(eq(schema.digestDeliveries.digestId, digestId));
}

/** Always fails, so the failure path can be driven without an SMTP server. */
function createFailingTransport(reason = "mailbox full"): EmailTransport {
  return {
    name: "failing",
    async send(): Promise<{ ok: false; reason: string; retryable: boolean }> {
      return { ok: false, reason, retryable: false };
    },
  };
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await getAdminDb().delete(schema.users).where(inArray(schema.users.id, userIds));
  await closeDatabasePools();
});

describe("sending", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("send");
  });

  it("mails everyone who chose weekly delivery", async () => {
    const transport = createCaptureTransport();

    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport,
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(transport.sent).toHaveLength(2);
  });

  it("carries the briefing and the actions, not just a link", async () => {
    const message = (await sentTo(fixture, "send-owner"))!;

    expect(message.text).toContain("Service is holding up");
    expect(message.text).toContain("Reply to the two unanswered reviews.");
    expect(message.text).toContain("Thank the regulars who named Deniz.");
    expect(message.text).toContain(`/digest/${fixture.digestId}`);
  });

  it("records one ledger row per recipient", async () => {
    const rows = await deliveriesFor(fixture.digestId);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "sent")).toBe(true);
    expect(rows.every((row) => row.sentAt !== null)).toBe(true);
    expect(rows.every((row) => row.channel === "email")).toBe(true);
  });
});

/** Re-runs the send for one fixture and returns the message for a named user. */
async function sentTo(fixture: Fixture, label: string): Promise<EmailMessage | undefined> {
  const transport = createCaptureTransport();

  // A fresh organization each time would be cleaner, but the point of this
  // helper is to inspect what the *first* send produced — so it clears the
  // ledger rather than the fixture.
  await getAdminDb()
    .delete(schema.digestDeliveries)
    .where(eq(schema.digestDeliveries.digestId, fixture.digestId));

  await sendDigestEmails({
    organizationId: fixture.orgId,
    periodStart: WINDOW.start,
    transport,
  });

  return transport.sent.find((message) => message.to.startsWith(label));
}

describe("idempotency", () => {
  it("does not mail the same digest twice", async () => {
    const fixture = await makeFixture("idempotent");

    const first = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: createCaptureTransport(),
    });
    expect(first.sent).toBe(2);

    // The sweep runs hourly and is allowed to re-run. This is the assertion
    // that stops it mailing a business its own briefing every hour.
    const second = createCaptureTransport();
    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: second,
    });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(2);
    expect(second.sent).toHaveLength(0);
  });

  it("retries only the recipients whose send failed", async () => {
    const fixture = await makeFixture("partial");

    const failed = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: createFailingTransport(),
    });
    expect(failed.failed).toBe(2);
    expect(failed.sent).toBe(0);

    const rows = await deliveriesFor(fixture.digestId);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(rows.every((row) => row.error === "mailbox full")).toBe(true);

    // A failed row is not "delivered" — it is exactly what a retry is for.
    const retry = createCaptureTransport();
    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: retry,
    });

    expect(result.sent).toBe(2);
    expect(retry.sent).toHaveLength(2);

    // Updated in place: still one row per recipient, now sent.
    const after = await deliveriesFor(fixture.digestId);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.status === "sent")).toBe(true);
    expect(after.every((row) => row.error === null)).toBe(true);
  });
});

describe("who gets it", () => {
  it("skips people who chose instant delivery — they already had their email", async () => {
    const fixture = await makeFixture("instant");
    await withDefaultPreference(fixture, fixture.memberId, "instant");

    const transport = createCaptureTransport();
    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport,
    });

    expect(result.sent).toBe(1);
    expect(transport.sent[0]!.to).toContain("instant-owner");
  });

  it("honours email: false — the feed only", async () => {
    const fixture = await makeFixture("no-email");
    await withDefaultPreference(fixture, fixture.memberId, "digest", { email: false });

    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: createCaptureTransport(),
    });

    expect(result.sent).toBe(1);
  });

  it("honours scope: off", async () => {
    const fixture = await makeFixture("scope-off");
    await withDefaultPreference(fixture, fixture.memberId, "digest", { scope: "off" });

    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: createCaptureTransport(),
    });

    expect(result.sent).toBe(1);
  });

  it("does not mail a digest that is not ready", async () => {
    const fixture = await makeFixture("pending", { status: "pending" });

    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: createCaptureTransport(),
    });

    expect(result.sent).toBe(0);
  });
});

describe("held new-review alerts", () => {
  it("closes out the deferred notifications the digest carried", async () => {
    const fixture = await makeFixture("held");

    const inWindow = await addHeldNotification(
      fixture,
      fixture.ownerId,
      new Date("2026-07-29T09:00:00Z"),
    );
    // Belongs to the following week, so this digest is not the one that
    // discharges it — counting it here would mean it is never mailed at all.
    const afterWindow = await addHeldNotification(
      fixture,
      fixture.ownerId,
      new Date("2026-08-05T09:00:00Z"),
    );

    const transport = createCaptureTransport();
    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport,
    });

    expect(result.held).toBe(1);

    const owner = transport.sent.find((message) => message.to.startsWith("held-owner"))!;
    expect(owner.text).toContain("1 new-review alert you asked us to hold");

    const [discharged] = await getAdminDb()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inWindow));
    expect(discharged!.emailStatus).toBe("sent");
    expect(discharged!.emailedAt).not.toBeNull();

    const [untouched] = await getAdminDb()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, afterWindow));
    expect(untouched!.emailStatus).toBe("deferred");
  });

  it("leaves them deferred when the send fails", async () => {
    const fixture = await makeFixture("held-failed");
    const held = await addHeldNotification(
      fixture,
      fixture.ownerId,
      new Date("2026-07-29T09:00:00Z"),
    );

    const result = await sendDigestEmails({
      organizationId: fixture.orgId,
      periodStart: WINDOW.start,
      transport: createFailingTransport(),
    });

    expect(result.held).toBe(0);

    // Discharging them on a failed send would lose the alerts entirely: the
    // retry would carry a count of zero and nothing would ever have been sent.
    const [row] = await getAdminDb()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, held));
    expect(row!.emailStatus).toBe("deferred");
  });
});

describe("tenant isolation", () => {
  it("never sends another organization's digest", async () => {
    const mine = await makeFixture("mine");
    const theirs = await makeFixture("theirs");

    const transport = createCaptureTransport();
    await sendDigestEmails({
      organizationId: mine.orgId,
      periodStart: WINDOW.start,
      transport,
    });

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent.every((message) => message.to.includes("mine-"))).toBe(true);

    const theirRows = await getAdminDb()
      .select()
      .from(schema.digestDeliveries)
      .where(
        and(
          eq(schema.digestDeliveries.digestId, theirs.digestId),
          eq(schema.digestDeliveries.channel, "email"),
        ),
      );
    expect(theirRows).toHaveLength(0);
  });
});
