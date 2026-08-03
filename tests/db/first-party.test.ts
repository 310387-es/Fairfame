import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCampaign, listCampaigns } from "@/collect/campaigns";
import type { CreateCampaignInput } from "@/collect/input";
import {
  markRequestOpened,
  resolveCampaignBySlug,
  resolveRequestByToken,
  unsubscribeByToken,
} from "@/collect/public";
import { sendReviewRequests } from "@/collect/requests";
import { submitReview } from "@/collect/submissions";
import { FIRST_PARTY_PROVIDER } from "@/connectors/firstparty";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import type { Campaign } from "@/db/schema";
import { EntitlementError } from "@/lib/entitlements";
import { getEnv } from "@/lib/env";
import { PLAN_CATALOG } from "@/lib/plans";
import { closeRateLimiter } from "@/lib/rate-limit";
import { withTenant } from "@/lib/tenancy";
import { createCaptureTransport, setEmailTransportForTesting } from "@/messaging/email";

/**
 * First-party collection, end to end against a real database (P1b-T1).
 *
 * This is the task's Definition of Done expressed as a test: ask a customer,
 * they open the link, they submit, and the review lands in the canonical table
 * through the same connector path a Google review would take — tenant-isolated,
 * metered, and with the opt-out honoured.
 *
 * Fixtures are written with the owner connection (which bypasses RLS) so the
 * assertions afterwards are testing the product's behaviour rather than testing
 * whether the fixture insert worked.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const capture = createCaptureTransport();

type Fixture = { orgId: string; locationId: string };

async function makeOrg(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({
      name: `Collect ${label} ${suffix}`,
      slug: `collect-${label}-${suffix}`,
      locale: "tr",
    })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: `${label} Şubesi` })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  return { orgId: org.id, locationId: location.id };
}

async function makeCampaign(
  fixture: Fixture,
  overrides: Partial<CreateCampaignInput> = {},
): Promise<Campaign> {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    createCampaign(tx, {
      organizationId: fixture.orgId,
      actorUserId: null,
      input: {
        locationId: fixture.locationId,
        name: "Ziyaret sonrası",
        channel: "email",
        destination: "firstparty",
        destinationUrl: null,
        locale: "tr",
        subject: null,
        body: null,
        ...overrides,
      },
    }),
  );
}

/** The most recent request row for a campaign, read past RLS for assertions. */
async function latestRequest(campaignId: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.reviewRequests)
    .where(eq(schema.reviewRequests.campaignId, campaignId))
    .orderBy(desc(schema.reviewRequests.createdAt))
    .limit(1);
  return row;
}

async function reviewsOf(orgId: string) {
  return getAdminDb()
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.organizationId, orgId),
        eq(schema.reviews.source, FIRST_PARTY_PROVIDER),
      ),
    );
}

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  // Nothing may leave the machine during a test run.
  setEmailTransportForTesting(capture);
  a = await makeOrg("a");
  b = await makeOrg("b");
});

afterAll(async () => {
  setEmailTransportForTesting(null);
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeRateLimiter();
  await closeDatabasePools();
});

describe("creating a campaign", () => {
  it("mints a readable public slug and opens for submissions", async () => {
    const campaign = await makeCampaign(a);

    expect(campaign.slug).toMatch(/^ziyaret-sonrasi-[a-z0-9]{6}$/);
    expect(campaign.status).toBe("active");
    expect(campaign.organizationId).toBe(a.orgId);
  });

  it("connects the location as a first-party source", async () => {
    await makeCampaign(a, { name: "Kaynak" });

    const [connection] = await getAdminDb()
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.locationId, a.locationId),
          eq(schema.connections.provider, FIRST_PARTY_PROVIDER),
        ),
      );

    // Without this the submission has no connection to carry locationId into
    // normalize(), and the source never appears beside Google in the UI.
    expect(connection?.status).toBe("active");
    expect(connection?.capabilities).toMatchObject({ read: "full", reply: "none" });
  });

  it("is resolvable by slug without any tenant context", async () => {
    const campaign = await makeCampaign(a, { name: "Herkese açık" });
    const resolved = await resolveCampaignBySlug(campaign.slug);

    expect(resolved?.organizationId).toBe(a.orgId);
    expect(resolved?.locationName).toBe("a Şubesi");
    expect(resolved?.locale).toBe("tr");
  });

  it("returns nothing for a slug that does not exist", async () => {
    expect(await resolveCampaignBySlug("no-such-campaign")).toBeNull();
    // A path-traversal shaped slug is rejected before it reaches the database.
    expect(await resolveCampaignBySlug("../../etc/passwd")).toBeNull();
  });
});

describe("sending a review request", () => {
  it("emails the customer a tracked link and meters the send", async () => {
    const campaign = await makeCampaign(a, { name: "Gönderim" });
    const before = capture.sent.length;

    const outcome = await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "ayse@example.com", name: "Ayşe" }],
    });

    expect(outcome).toMatchObject({ sent: 1, failed: 0 });

    const request = await latestRequest(campaign.id);
    expect(request?.status).toBe("sent");
    expect(request?.sentAt).not.toBeNull();

    const message = capture.sent[before];
    expect(message?.to).toBe("ayse@example.com");
    expect(message?.text).toContain(`/r/${request?.token}`);
    // Every commercial message carries its opt-out, in the body and the headers.
    expect(message?.text).toContain(`/u/${request?.token}`);
    expect(message?.listUnsubscribeUrl).toContain(`/u/${request?.token}`);

    const [usage] = await getAdminDb()
      .select()
      .from(schema.usageCounters)
      .where(
        and(
          eq(schema.usageCounters.organizationId, a.orgId),
          eq(schema.usageCounters.metric, "requests_per_month"),
        ),
      );
    expect(usage?.count).toBeGreaterThanOrEqual(1);
  });

  it("writes the recipient to contacts, not into the review payload", async () => {
    const campaign = await makeCampaign(a, { name: "Kişi" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "kisi@example.com", name: "Kişi" }],
    });

    const [contact] = await getAdminDb()
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.organizationId, a.orgId),
          eq(schema.contacts.email, "kisi@example.com"),
        ),
      );

    expect(contact?.name).toBe("Kişi");
    expect(contact?.locale).toBe("tr");
  });

  it("refuses to send for a link campaign, which has nothing to send", async () => {
    const campaign = await makeCampaign(a, { name: "QR", channel: "link" });

    await expect(
      sendReviewRequests({
        organizationId: a.orgId,
        actorUserId: null,
        campaignId: campaign.id,
        recipients: [{ email: "x@example.com", name: null }],
      }),
    ).rejects.toThrow(/nothing to send/i);
  });
});

describe("the funnel", () => {
  it("records an open once and never walks the status backwards", async () => {
    const campaign = await makeCampaign(a, { name: "Açılma" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "acilma@example.com", name: null }],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");

    const resolved = await resolveRequestByToken(request.token);
    expect(resolved?.campaign.campaignId).toBe(campaign.id);

    const firstOpen = new Date("2026-08-02T09:00:00Z");
    await markRequestOpened(a.orgId, request.id, firstOpen);
    const opened = await latestRequest(campaign.id);
    expect(opened?.status).toBe("opened");
    expect(opened?.openedAt?.toISOString()).toBe(firstOpen.toISOString());

    // A second visit a day later must not restate when they first opened it.
    await markRequestOpened(a.orgId, request.id, new Date("2026-08-03T09:00:00Z"));
    const reopened = await latestRequest(campaign.id);
    expect(reopened?.openedAt?.toISOString()).toBe(firstOpen.toISOString());
  });

  it("turns a submission into a canonical review and closes the ask", async () => {
    const campaign = await makeCampaign(a, { name: "Dönüşüm" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "donusum@example.com", name: "Dönüş" }],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");

    const result = await submitReview(
      {
        slug: campaign.slug,
        requestToken: request.token,
        rating: 5,
        comment: "Servis çok hızlıydı.",
        authorName: "Dönüş",
        email: "donusum@example.com",
        kvkkAccepted: true,
      },
      { ip: `test-${suffix}-conversion` },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [review] = await getAdminDb()
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, result.reviewId));

    expect(review).toMatchObject({
      organizationId: a.orgId,
      locationId: a.locationId,
      source: FIRST_PARTY_PROVIDER,
      rating: 5,
      text: "Servis çok hızlıydı.",
      language: "tr",
    });
    // The provider payload is retained verbatim, as for every other source.
    expect(review?.rawPayload).toMatchObject({ campaign: { slug: campaign.slug } });

    const closed = await latestRequest(campaign.id);
    expect(closed?.status).toBe("submitted");
    expect(closed?.reviewId).toBe(result.reviewId);
    expect(closed?.submittedAt).not.toBeNull();
    // Converting implies opening, even if the open ping never arrived.
    expect(closed?.openedAt).not.toBeNull();

    const [consent] = await getAdminDb()
      .select()
      .from(schema.consentRecords)
      .where(
        and(
          eq(schema.consentRecords.organizationId, a.orgId),
          eq(schema.consentRecords.type, "kvkk"),
        ),
      );
    expect(consent?.grantedAt).not.toBeNull();
    expect(consent?.proofRef).toMatch(/^submission:/);
  });

  it("refuses to let one request token leave two reviews", async () => {
    const campaign = await makeCampaign(a, { name: "Tekrar" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "tekrar@example.com", name: null }],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");

    const submission = {
      slug: campaign.slug,
      requestToken: request.token,
      rating: 4,
      comment: "İyiydi.",
      authorName: null,
      email: null,
      kvkkAccepted: false,
    };

    expect((await submitReview(submission, { ip: `test-${suffix}-once-a` })).ok).toBe(true);
    expect(await submitReview(submission, { ip: `test-${suffix}-once-b` })).toEqual({
      ok: false,
      error: "already_submitted",
    });
  });

  it("rejects a token belonging to another campaign", async () => {
    const [one, two] = await Promise.all([
      makeCampaign(a, { name: "Kampanya bir" }),
      makeCampaign(a, { name: "Kampanya iki" }),
    ]);

    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: one.id,
      recipients: [{ email: "capraz@example.com", name: null }],
    });

    const request = await latestRequest(one.id);
    if (!request) throw new Error("request fixture missing");

    expect(
      await submitReview(
        {
          slug: two.slug,
          requestToken: request.token,
          rating: 5,
          comment: "",
          authorName: null,
          email: null,
          kvkkAccepted: false,
        },
        { ip: `test-${suffix}-cross` },
      ),
    ).toEqual({ ok: false, error: "wrong_campaign" });
  });

  it("accepts a walk-in with no request behind it", async () => {
    const campaign = await makeCampaign(a, { name: "Yerinde", channel: "link" });

    const result = await submitReview(
      {
        slug: campaign.slug,
        requestToken: null,
        rating: 4,
        comment: "QR ile bıraktım.",
        authorName: null,
        email: null,
        kvkkAccepted: false,
      },
      { ip: `test-${suffix}-walkin` },
    );

    expect(result.ok).toBe(true);

    const request = await latestRequest(campaign.id);
    expect(request).toMatchObject({ channel: "link", status: "submitted", contactId: null });
    // Nothing was sent, so the funnel legitimately starts at "submitted".
    expect(request?.sentAt).toBeNull();
    expect(request?.meta).toMatchObject({ walkIn: true });
  });

  it("counts the funnel per campaign", async () => {
    const campaign = await makeCampaign(a, { name: "Sayaç" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [
        { email: "sayac1@example.com", name: null },
        { email: "sayac2@example.com", name: null },
      ],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");
    await markRequestOpened(a.orgId, request.id);

    const campaigns = await withTenant({ organizationId: a.orgId }, (tx) =>
      listCampaigns(tx, a.orgId),
    );
    const counted = campaigns.find((row) => row.id === campaign.id);

    expect(counted?.funnel).toEqual({ sent: 2, opened: 1, submitted: 0 });
  });
});

describe("no rating-gating", () => {
  it("treats a one-star and a five-star submission identically", async () => {
    const campaign = await makeCampaign(a, { name: "Eşit muamele", channel: "link" });

    for (const [index, rating] of [1, 5].entries()) {
      const result = await submitReview(
        {
          slug: campaign.slug,
          requestToken: null,
          rating,
          comment: `Puan ${rating}`,
          authorName: null,
          email: null,
          kvkkAccepted: false,
        },
        { ip: `test-${suffix}-gate-${index}` },
      );
      expect(result.ok, `rating ${rating}`).toBe(true);
    }

    const rows = await getAdminDb()
      .select()
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.campaignId, campaign.id));

    // Same campaign, same channel, same status: the unhappy customer was not
    // routed anywhere different, and their review is in the same table.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["submitted"]));
    expect(new Set(rows.map((row) => row.channel))).toEqual(new Set(["link"]));

    const stored = await getAdminDb()
      .select({ rating: schema.reviews.rating })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.organizationId, a.orgId),
          inArray(
            schema.reviews.id,
            rows.map((row) => row.reviewId).filter((id): id is string => id !== null),
          ),
        ),
      );
    expect(stored.map((row) => row.rating).sort()).toEqual([1, 5]);
  });
});

describe("tenant isolation", () => {
  it("keeps one organization's campaigns invisible to another", async () => {
    const campaign = await makeCampaign(a, { name: "Gizli" });

    const seenByB = await withTenant({ organizationId: b.orgId }, (tx) =>
      listCampaigns(tx, b.orgId),
    );
    expect(seenByB.some((row) => row.id === campaign.id)).toBe(false);

    // Even naming the row explicitly under B's context returns nothing: the
    // policy is enforced by Postgres, not by the query's where clause.
    const direct = await withTenant({ organizationId: b.orgId }, (tx) =>
      tx.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaign.id)),
    );
    expect(direct).toHaveLength(0);
  });

  it("writes a submission only into the organization that owns the slug", async () => {
    const campaign = await makeCampaign(a, { name: "Sahiplik", channel: "link" });
    const before = (await reviewsOf(b.orgId)).length;

    const result = await submitReview(
      {
        slug: campaign.slug,
        requestToken: null,
        rating: 3,
        comment: "Ortalama.",
        authorName: null,
        email: null,
        kvkkAccepted: false,
      },
      { ip: `test-${suffix}-owner` },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [review] = await getAdminDb()
      .select({ organizationId: schema.reviews.organizationId })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, result.reviewId));

    expect(review?.organizationId).toBe(a.orgId);
    expect((await reviewsOf(b.orgId)).length).toBe(before);
  });

  it("hides another tenant's request rows", async () => {
    const campaign = await makeCampaign(a, { name: "Talep gizli" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "gizli@example.com", name: null }],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");

    const seenByB = await withTenant({ organizationId: b.orgId }, (tx) =>
      tx.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.id, request.id)),
    );
    expect(seenByB).toHaveLength(0);
  });
});

describe("opt-out", () => {
  it("honours an unsubscribe on every later send", async () => {
    const campaign = await makeCampaign(a, { name: "Çıkış" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "cikis@example.com", name: null }],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");

    const result = await unsubscribeByToken(request.token);
    expect(result).toEqual({ ok: true, email: "cikis@example.com" });

    const outcome = await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "cikis@example.com", name: null }],
    });

    // Skipped before anything is queued: no row should imply we meant to write.
    expect(outcome.sent).toBe(0);
    expect(outcome.skipped).toEqual([{ email: "cikis@example.com", reason: "unsubscribed" }]);
  });

  it("is idempotent and keeps the original opt-out time", async () => {
    const campaign = await makeCampaign(a, { name: "Çıkış tekrar" });
    await sendReviewRequests({
      organizationId: a.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "cikis2@example.com", name: null }],
    });

    const request = await latestRequest(campaign.id);
    if (!request) throw new Error("request fixture missing");

    await unsubscribeByToken(request.token, new Date("2026-08-02T00:00:00Z"));
    await unsubscribeByToken(request.token, new Date("2026-08-05T00:00:00Z"));

    const [contact] = await getAdminDb()
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.organizationId, a.orgId),
          eq(schema.contacts.email, "cikis2@example.com"),
        ),
      );

    expect(contact?.unsubscribedAt?.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("reports failure for an unknown token", async () => {
    expect(await unsubscribeByToken("abcdefghjkmnpqrstuvwx")).toEqual({ ok: false, email: null });
  });
});

describe("entitlements", () => {
  it("blocks a send that would exceed the plan's monthly allowance", async () => {
    const c = await makeOrg("c");

    const [plan] = await getAdminDb()
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.key, "starter"))
      .limit(1);
    if (!plan) throw new Error("plans not seeded — run pnpm db:seed");

    await getAdminDb()
      .insert(schema.subscriptions)
      .values({
        organizationId: c.orgId,
        planId: plan.id,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        // Config, not code: the same send path allows or denies purely on this.
        overrides: { limits: { requests_per_month: 1 } },
      });

    const campaign = await makeCampaign(c, { name: "Limit" });

    await expect(
      sendReviewRequests({
        organizationId: c.orgId,
        actorUserId: null,
        campaignId: campaign.id,
        recipients: [
          { email: "limit1@example.com", name: null },
          { email: "limit2@example.com", name: null },
        ],
      }),
    ).rejects.toThrow(EntitlementError);

    // Nothing was created for the rejected batch.
    expect(await latestRequest(campaign.id)).toBeUndefined();

    const outcome = await sendReviewRequests({
      organizationId: c.orgId,
      actorUserId: null,
      campaignId: campaign.id,
      recipients: [{ email: "limit1@example.com", name: null }],
    });
    expect(outcome.sent).toBe(1);
  });

  it("leaves an organization with no subscription on the default plan's allowance", async () => {
    // Not zero, and not unlimited: the floor is Starter (docs/03 §7.1).
    expect(PLAN_CATALOG.starter.entitlements.limits.requests_per_month).toBe(100);
  });
});

describe("abuse guards", () => {
  it("closes an archived campaign to new submissions", async () => {
    const campaign = await makeCampaign(a, { name: "Arşiv", channel: "link" });

    await withTenant({ organizationId: a.orgId }, (tx) =>
      tx
        .update(schema.campaigns)
        .set({ status: "archived" })
        .where(eq(schema.campaigns.id, campaign.id)),
    );

    expect(
      await submitReview(
        {
          slug: campaign.slug,
          requestToken: null,
          rating: 5,
          comment: "",
          authorName: null,
          email: null,
          kvkkAccepted: false,
        },
        { ip: `test-${suffix}-archived` },
      ),
    ).toEqual({ ok: false, error: "closed" });
  });

  it("rate limits a flood from one device", async () => {
    const campaign = await makeCampaign(a, { name: "Sel", channel: "link" });
    const limit = getEnv().PUBLIC_SUBMIT_LIMIT;
    const ip = `test-${suffix}-flood`;

    const submission = {
      slug: campaign.slug,
      requestToken: null,
      rating: 5,
      comment: "spam",
      authorName: null,
      email: null,
      kvkkAccepted: false,
    };

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      expect((await submitReview(submission, { ip })).ok, `attempt ${attempt}`).toBe(true);
    }

    expect(await submitReview(submission, { ip })).toEqual({ ok: false, error: "rate_limited" });

    // The limit is per campaign as well as per IP: one venue's traffic must not
    // throttle another's, since a whole café shares one NAT address.
    const other = await makeCampaign(a, { name: "Başka sel", channel: "link" });
    expect((await submitReview({ ...submission, slug: other.slug }, { ip })).ok).toBe(true);
  });
});
