import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `getTranslations` needs a Next request context, which Vitest has no way to
 * provide. Stubbing it is what lets the embed route run for real here — and the
 * one assertion that route is here for (does the CSP header match the bytes
 * sent?) does not depend on the copy, only on the document being real. The
 * translations themselves are covered by `pnpm check:i18n` and by the browser
 * suite, which loads the page in an actual server.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

import { GET } from "@/app/api/public/widgets/[publicKey]/route";
import { GET as GET_DOCUMENT } from "@/app/embed/w/[publicKey]/route";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { widgetContentSecurityPolicy } from "@/widgets/csp";
import { generateWidgetKey } from "@/widgets/keys";
import { loadWidgetContent, resolveWidgetByKey } from "@/widgets/public";

/**
 * The public widget surface (P3-T0), and the leak test `docs/19` calls the
 * headline one.
 *
 * The threat model is specific and worth stating, because it is not the usual
 * one. Everywhere else in the product a tenancy bug shows another *customer's*
 * data to a signed-in user who at least had to have an account. Here there is
 * no account: the endpoint answers anyone on the internet holding a 24-character
 * string, and whatever it returns is cached by a CDN and rendered on somebody
 * else's homepage. So the assertions below are not "does the filter work" —
 * they are "can a stranger, by any route, see a row that is not this widget's".
 *
 * Four gates, each tested on its own so a regression names itself:
 *   1. the organization, which comes from the key and nowhere else
 *   2. the location, when the widget names one
 *   3. approval — `display_approved_at`, which nothing exposed can turn off
 *   4. the projection, which is an allow-list and must never grow by accident
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Org = {
  orgId: string;
  mainLocationId: string;
  otherLocationId: string;
  approvedReviewId: string;
  unapprovedReviewId: string;
};

async function makeOrg(label: string): Promise<Org> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Widgets ${label} ${suffix}`, slug: `widgets-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} Merkez`, locale: "tr" },
      { organizationId: org.id, name: `${label} Havalimanı`, locale: "tr" },
    ])
    .returning({ id: schema.locations.id });

  const mainLocationId = locations[0]!.id;
  const otherLocationId = locations[1]!.id;

  const rows = await getAdminDb()
    .insert(schema.reviews)
    .values([
      {
        organizationId: org.id,
        locationId: mainLocationId,
        source: "google",
        sourceReviewId: `${label}-approved`,
        authorName: `${label} Approved Author`,
        rating: 5,
        text: `An approved review belonging to ${label}`,
        postedAt: new Date("2026-07-20T10:00:00Z"),
        rawPayload: { secret: `raw payload for ${label}` },
        displayApprovedAt: new Date("2026-07-21T10:00:00Z"),
      },
      {
        organizationId: org.id,
        locationId: mainLocationId,
        source: "google",
        sourceReviewId: `${label}-unapproved`,
        authorName: `${label} Unapproved Author`,
        rating: 1,
        text: `An unapproved review belonging to ${label}`,
        postedAt: new Date("2026-07-22T10:00:00Z"),
        rawPayload: {},
      },
    ])
    .returning({ id: schema.reviews.id });

  return {
    orgId: org.id,
    mainLocationId,
    otherLocationId,
    approvedReviewId: rows[0]!.id,
    unapprovedReviewId: rows[1]!.id,
  };
}

async function makeWidget(
  org: Org,
  overrides: Partial<typeof schema.widgets.$inferInsert> = {},
): Promise<string> {
  const publicKey = generateWidgetKey();
  await getAdminDb()
    .insert(schema.widgets)
    .values({
      organizationId: org.orgId,
      name: "Testimonials",
      publicKey,
      published: true,
      ...overrides,
    });
  return publicKey;
}

let alpha: Org;
let beta: Org;

beforeAll(async () => {
  [alpha, beta] = await Promise.all([makeOrg("alpha"), makeOrg("beta")]);
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("the tenancy boundary", () => {
  it("returns one organization's reviews and nothing of anyone else's", async () => {
    const key = await makeWidget(alpha);

    const widget = await resolveWidgetByKey(key);
    expect(widget?.organizationId).toBe(alpha.orgId);

    const { reviews } = await loadWidgetContent(widget!);

    // The positive half: alpha's approved review is there.
    expect(reviews.map((review) => review.id)).toEqual([alpha.approvedReviewId]);

    // The half that matters: nothing of beta's, by id or by content. Checking
    // the text too, because an id match alone would still pass if the payload
    // carried another org's words under alpha's id.
    const serialized = JSON.stringify(reviews);
    expect(serialized).not.toContain(beta.approvedReviewId);
    expect(serialized).not.toContain("beta");
  });

  it("scopes to the widget's location when it names one", async () => {
    await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: alpha.orgId,
        locationId: alpha.otherLocationId,
        source: "google",
        sourceReviewId: `alpha-other-location`,
        rating: 5,
        text: "Approved, but at the other branch",
        postedAt: new Date("2026-07-25T10:00:00Z"),
        rawPayload: {},
        displayApprovedAt: new Date("2026-07-25T11:00:00Z"),
      });

    const scoped = await resolveWidgetByKey(
      await makeWidget(alpha, { locationId: alpha.mainLocationId }),
    );
    const orgWide = await resolveWidgetByKey(await makeWidget(alpha));

    const scopedReviews = await loadWidgetContent(scoped!);
    const orgWideReviews = await loadWidgetContent(orgWide!);

    expect(scopedReviews.reviews.map((review) => review.text)).toEqual([
      "An approved review belonging to alpha",
    ]);
    expect(orgWideReviews.reviews).toHaveLength(2);
  });

  it("has no input that can name an organization", async () => {
    // Not a runtime assertion but a structural one: if a future signature grows
    // an `organizationId` parameter, the public endpoint has acquired the exact
    // shape this whole module exists to avoid. `resolveWidgetByKey` takes one
    // string, and `loadWidgetContent` takes only what that returned.
    expect(resolveWidgetByKey).toHaveLength(1);
    expect(loadWidgetContent).toHaveLength(1);
  });
});

describe("the approval gate", () => {
  it("never returns a review that has not been approved", async () => {
    const widget = await resolveWidgetByKey(await makeWidget(alpha));
    const { reviews } = await loadWidgetContent(widget!);

    expect(reviews.map((review) => review.id)).not.toContain(alpha.unapprovedReviewId);
  });

  it("starts every existing review unapproved", async () => {
    // The backfill decision, asserted. A migration that defaulted this column to
    // "approved" would publish every review in the product the moment somebody
    // made their first widget, and the failure would be silent.
    const [row] = await getAdminDb()
      .select({ approvedAt: schema.reviews.displayApprovedAt })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, alpha.unapprovedReviewId));

    expect(row?.approvedAt).toBeNull();
  });

  it("refuses to let a direct message be approved at all", async () => {
    const [dm] = await getAdminDb()
      .insert(schema.reviews)
      .values({
        organizationId: alpha.orgId,
        locationId: alpha.mainLocationId,
        source: "instagram",
        itemType: "dm",
        sourceReviewId: "alpha-dm",
        text: "A private message that must never reach a marketing page",
        rawPayload: {},
      })
      .returning({ id: schema.reviews.id });

    // The database says no — not a WHERE clause somebody could forget. Drizzle
    // wraps driver errors, so the constraint name is on `cause`; asserting the
    // wrapper's text would pass for any failure at all.
    await expect(
      getAdminDb()
        .update(schema.reviews)
        .set({ displayApprovedAt: new Date() })
        .where(eq(schema.reviews.id, dm!.id))
        .catch((error: unknown) => {
          let root: unknown = error;
          while (root instanceof Error && root.cause instanceof Error) root = root.cause;
          throw root;
        }),
    ).rejects.toThrow(/reviews_dm_never_published/);
  });
});

describe("what the widget's filters select", () => {
  it("applies the minimum rating, the source list and the text requirement", async () => {
    const org = await makeOrg("filters");
    const approved = new Date("2026-07-26T10:00:00Z");

    await getAdminDb()
      .insert(schema.reviews)
      .values([
        {
          organizationId: org.orgId,
          locationId: org.mainLocationId,
          source: "google",
          sourceReviewId: "filters-three-star",
          rating: 3,
          text: "Three stars, with words",
          postedAt: new Date("2026-07-26T09:00:00Z"),
          rawPayload: {},
          displayApprovedAt: approved,
        },
        {
          organizationId: org.orgId,
          locationId: org.mainLocationId,
          source: "instagram",
          sourceReviewId: "filters-other-source",
          rating: 5,
          text: "Five stars, wrong source",
          postedAt: new Date("2026-07-26T09:30:00Z"),
          rawPayload: {},
          displayApprovedAt: approved,
        },
        {
          organizationId: org.orgId,
          locationId: org.mainLocationId,
          source: "google",
          sourceReviewId: "filters-no-text",
          rating: 5,
          text: "   ",
          postedAt: new Date("2026-07-26T09:45:00Z"),
          rawPayload: {},
          displayApprovedAt: approved,
        },
      ]);

    const widget = await resolveWidgetByKey(
      await makeWidget(org, {
        filters: { sources: ["google"], minRating: 4, requireText: true, count: 20 },
      }),
    );

    const { reviews } = await loadWidgetContent(widget!);

    // Only the org's own 5-star Google review with real text survives all three.
    expect(reviews.map((review) => review.text)).toEqual([
      "An approved review belonging to filters",
    ]);
  });

  it("falls back to the defaults when the stored config is unreadable", async () => {
    // A hand-edited row must not 500 a customer's homepage.
    const widget = await resolveWidgetByKey(
      await makeWidget(alpha, { filters: { minRating: "very good" }, style: 42 }),
    );

    expect(widget?.filters.minRating).toBeNull();
    expect(widget?.style.layout).toBe("grid");
  });
});

describe("the aggregate beside the reviews", () => {
  it("counts every rated review in scope, not just the approved ones", async () => {
    // The integrity rule: a business may choose which reviews it quotes; it may
    // not choose the score. Alpha has a 5 and a 1 at the main location, so the
    // honest average is 3 even though only the 5 is on display.
    const widget = await resolveWidgetByKey(
      await makeWidget(alpha, { locationId: alpha.mainLocationId }),
    );

    const { reviews, aggregate } = await loadWidgetContent(widget!);

    expect(reviews).toHaveLength(1);
    expect(aggregate).toEqual({ basis: "all_reviews_in_scope", average: 3, count: 2 });
  });

  it("ignores the widget's minimum rating, which is an editorial filter", async () => {
    // The second half of the same rule, and the easier one to break: a business
    // that sets "4 stars and up" is choosing what its widget *quotes*. If that
    // filter reached the aggregate, the badge would read 5,0 for a business
    // whose customers gave it a 3.
    const widget = await resolveWidgetByKey(
      await makeWidget(alpha, {
        locationId: alpha.mainLocationId,
        filters: { minRating: 4, requireText: false, sources: [], count: 9 },
      }),
    );

    const { aggregate } = await loadWidgetContent(widget!);

    expect(aggregate).toEqual({ basis: "all_reviews_in_scope", average: 3, count: 2 });
  });
});

describe("the rating badge", () => {
  it("serves the honest average, over reviews the business never approved", async () => {
    // End to end, through the real route: alpha's main branch has a 5 on display
    // and a 1 that is not, so the badge reads 3,0 — the number its customers
    // produced, not the one its approvals imply.
    const key = await makeWidget(alpha, {
      locationId: alpha.mainLocationId,
      style: { layout: "badge" },
    });

    const response = await GET_DOCUMENT(new Request(`https://example.com/embed/w/${key}`), {
      params: Promise.resolve({ publicKey: key }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("rvw-badge");
    // Turkish, from the branch's own locale — and so a decimal comma.
    expect(body).toContain("3,0");
    // A badge quotes nothing, approved or otherwise.
    expect(body).not.toContain("An approved review belonging to alpha");
    expect(body).not.toContain("An unapproved review");
  });
});

describe("the HTTP endpoint", () => {
  const request = (key: string) => new Request(`https://example.com/api/public/widgets/${key}`);
  const params = (key: string) => ({ params: Promise.resolve({ publicKey: key }) });

  it("serves an approved review as cacheable, cross-origin JSON", async () => {
    const key = await makeWidget(alpha, { locationId: alpha.mainLocationId });
    const response = await GET(request(key), params(key));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage");
    expect(response.headers.get("ETag")).toBeTruthy();

    const body = await response.json();
    expect(body.reviews).toHaveLength(1);
    expect(body.business.name).toContain("Widgets alpha");
  });

  it("publishes only the allow-listed fields", async () => {
    const key = await makeWidget(alpha, { locationId: alpha.mainLocationId });
    const body = await (await GET(request(key), params(key))).json();

    // The exact shape, asserted as a set. A new column on `reviews` reaching the
    // internet should fail here rather than ship.
    expect(Object.keys(body.reviews[0]).sort()).toEqual([
      "authorName",
      "id",
      "itemType",
      "postedAt",
      "rating",
      "source",
      "text",
      "url",
    ]);

    // And the ones that must never appear, named so the failure is legible.
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "rawPayload",
      "raw_payload",
      "secret",
      "organizationId",
      "locationId",
      "priority",
      "assigneeUserId",
      "slaDueAt",
      "status",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("answers the same way for an unknown key and an unpublished widget", async () => {
    const unpublished = await makeWidget(alpha, { published: false });
    const unknown = generateWidgetKey();

    const [a, b] = await Promise.all([
      GET(request(unpublished), params(unpublished)),
      GET(request(unknown), params(unknown)),
    ]);

    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    // Byte-identical: the endpoint must not become an oracle for which keys
    // exist. It also must not be cached, since publishing should take effect.
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects a malformed key without touching the database", async () => {
    const junk = "<script>alert(1)</script>";
    const response = await GET(request(junk), params(junk));
    expect(response.status).toBe(404);
  });

  it("serves an embed document whose CSP matches the bytes it sends", async () => {
    // The end-to-end half of tests/lib/widget-csp.test.ts. That one proves the
    // policy tracks a document; this proves the *response's* header tracks the
    // *response's* body — including whatever the framework does to either on
    // the way out.
    const key = await makeWidget(alpha, { locationId: alpha.mainLocationId });
    const response = await GET_DOCUMENT(
      new Request(`https://example.com/embed/w/${key}`),
      params(key),
    );

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(response.headers.get("Content-Security-Policy")).toBe(widgetContentSecurityPolicy(body));

    // And the document is the widget, not an error page that happens to hash.
    expect(body).toContain("An approved review belonging to alpha");
    expect(body).not.toContain("An unapproved review");
  });

  it("answers a matching conditional request with 304", async () => {
    const key = await makeWidget(alpha, { locationId: alpha.mainLocationId });
    const first = await GET(request(key), params(key));
    const etag = first.headers.get("ETag")!;

    const conditional = new Request(`https://example.com/api/public/widgets/${key}`, {
      headers: { "If-None-Match": etag },
    });
    const second = await GET(conditional, params(key));

    expect(second.status).toBe(304);
  });
});
