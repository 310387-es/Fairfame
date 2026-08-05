import { readdirSync } from "node:fs";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `getTranslations` needs a Next request context, which Vitest cannot provide.
 * Stubbing it lets the embed route render for real — and the assertions here do
 * not depend on the copy, only on which *rows* reach the response.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

import { GET as GET_WIDGET_JSON } from "@/app/api/public/widgets/[publicKey]/route";
import { GET as GET_EMBED } from "@/app/embed/w/[publicKey]/route";
import sitemap from "@/app/sitemap";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { generateWidgetKey } from "@/widgets/keys";
import { loadWidgetContent, resolveWidgetByKey } from "@/widgets/public";
import { loadLocationPageContent, resolveLocationPageBySlug } from "@/seo/page";

/**
 * **The headline test (P3-T8).**
 *
 * `docs/19` opens with a security note: the widget and SEO endpoints are public
 * and unauthenticated, so a tenancy leak here is not "one signed-in user saw
 * another customer's data" — it is on the open internet, served to anyone, and
 * for the indexable surfaces it is *crawled and cached* long after the bug is
 * fixed.
 *
 * Every public module already has its own tests. This file exists because those
 * are per-module, and the question that actually matters is per-*surface*: given
 * one hostile fixture, does **anything** a stranger can reach return **anything**
 * belonging to somebody else, or anything the owner did not approve?
 *
 * So it builds two organizations whose data is deliberately confusable, walks
 * every public entry point with the *first* one's credentials, and asserts the
 * second one is absent — by id, by review text, by author, by business name and
 * by branch name, because an id-only check would pass for a response that
 * carried another business's words under the right id.
 *
 * The last test is the one that catches the *next* leak rather than a known one:
 * it enumerates the public routes on disk and fails when a new one appears, so
 * adding a public surface forces a decision about this file.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Tenant = {
  orgId: string;
  orgName: string;
  locationId: string;
  locationName: string;
  widgetKey: string;
  badgeKey: string;
  slug: string;
  approvedId: string;
  unapprovedId: string;
  /** A word that appears only in this tenant's rows. */
  marker: string;
};

async function makeTenant(label: string): Promise<Tenant> {
  const marker = `${label}marker${suffix}`;
  const orgName = `Leak ${label} ${suffix}`;
  const locationName = `${label} Şubesi ${marker}`;

  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: orgName, slug: `leak-${label}-${suffix}`, locale: "tr" })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const slug = `leak-${label}-${suffix}`;
  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({
      organizationId: org.id,
      name: locationName,
      locale: "tr",
      address: `${marker} Caddesi 1`,
      publicSlug: slug,
      publicPagePublished: true,
    })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const reviews = await getAdminDb()
    .insert(schema.reviews)
    .values([
      {
        organizationId: org.id,
        locationId: location.id,
        source: "google",
        sourceReviewId: `${label}-approved`,
        authorName: `${marker} Author`,
        rating: 5,
        text: `Approved words belonging to ${marker}`,
        postedAt: new Date("2026-07-20T10:00:00Z"),
        rawPayload: { secret: `raw payload for ${marker}` },
        displayApprovedAt: new Date("2026-07-21T10:00:00Z"),
      },
      {
        organizationId: org.id,
        locationId: location.id,
        source: "google",
        sourceReviewId: `${label}-unapproved`,
        authorName: `${marker} Unapproved Author`,
        rating: 1,
        text: `Unapproved words belonging to ${marker}`,
        postedAt: new Date("2026-07-22T10:00:00Z"),
        rawPayload: {},
      },
      {
        organizationId: org.id,
        locationId: location.id,
        source: "instagram",
        itemType: "dm",
        sourceReviewId: `${label}-dm`,
        authorName: `${marker} Sender`,
        text: `Private message belonging to ${marker}`,
        postedAt: new Date("2026-07-23T10:00:00Z"),
        rawPayload: {},
      },
    ])
    .returning({ id: schema.reviews.id });

  const widgetKey = generateWidgetKey();
  const badgeKey = generateWidgetKey();

  await getAdminDb()
    .insert(schema.widgets)
    .values([
      {
        organizationId: org.id,
        locationId: location.id,
        name: `${marker} wall`,
        publicKey: widgetKey,
        published: true,
      },
      {
        organizationId: org.id,
        locationId: location.id,
        name: `${marker} badge`,
        publicKey: badgeKey,
        published: true,
        style: { layout: "badge" },
      },
    ]);

  return {
    orgId: org.id,
    orgName,
    locationId: location.id,
    locationName,
    widgetKey,
    badgeKey,
    slug,
    approvedId: reviews[0]!.id,
    unapprovedId: reviews[1]!.id,
    marker,
  };
}

let victim: Tenant;
let intruder: Tenant;

beforeAll(async () => {
  [victim, intruder] = await Promise.all([makeTenant("alpha"), makeTenant("beta")]);
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

const params = (value: string) => ({ params: Promise.resolve({ publicKey: value }) });
const request = (path: string) => new Request(`https://example.com${path}`);

/**
 * Everything that must never appear in a response served for `victim`.
 *
 * Named rather than inlined so a failure says *which* kind of leak happened,
 * and so a new public surface can be swept with one call.
 */
function assertClean(body: string, description: string) {
  for (const forbidden of [
    intruder.marker,
    intruder.orgId,
    intruder.locationId,
    intruder.approvedId,
    intruder.unapprovedId,
  ]) {
    expect(body, `${description} leaked another organization's data`).not.toContain(forbidden);
  }

  // The victim's own withheld rows, which are a leak of a different kind: the
  // business never chose to publish them.
  expect(body, `${description} exposed an unapproved review`).not.toContain("Unapproved words");
  expect(body, `${description} exposed a direct message`).not.toContain("Private message");
  // And the provider's raw response, which never leaves the server.
  expect(body, `${description} exposed a raw payload`).not.toContain("raw payload");
}

describe("every public surface, swept with one tenant's credentials", () => {
  it("the widget JSON endpoint", async () => {
    const response = await GET_WIDGET_JSON(
      request(`/api/public/widgets/${victim.widgetKey}`),
      params(victim.widgetKey),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    // The positive half, so a surface that returns nothing cannot pass.
    expect(body).toContain(victim.marker);
    assertClean(body, "the widget JSON endpoint");
  });

  it("the embed document", async () => {
    const response = await GET_EMBED(
      request(`/embed/w/${victim.widgetKey}`),
      params(victim.widgetKey),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Approved words");
    assertClean(body, "the embed document");
  });

  it("the rating badge, whose aggregate deliberately reads wider", async () => {
    // The badge counts *unapproved* reviews on purpose — the score is not
    // curated. That makes it the surface most likely to leak text it should
    // only be counting, so it gets its own sweep.
    const response = await GET_EMBED(
      request(`/embed/w/${victim.badgeKey}`),
      params(victim.badgeKey),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("rvw-badge");
    assertClean(body, "the badge document");
  });

  it("the hosted review page's data", async () => {
    // The page component is a server component and is exercised end to end in
    // `e2e/seo-page.spec.ts`; what a database test can hold is every row it
    // would render.
    const page = await resolveLocationPageBySlug(victim.slug);
    const content = await loadLocationPageContent(page!);

    expect(page?.organizationId).toBe(victim.orgId);
    expect(JSON.stringify(content)).toContain("Approved words");
    assertClean(JSON.stringify(content), "the hosted review page");
  });

  it("the sitemap, which is cross-tenant by design", async () => {
    // The one deliberate cross-tenant read in the app. It lists both tenants'
    // slugs — that is its job — so the assertion is about what it *does not*
    // carry: no organization id, no name, no review, no unpublished page.
    const entries = await sitemap();
    const body = JSON.stringify(entries);

    expect(body).toContain(victim.slug);
    expect(body).toContain(intruder.slug);

    for (const forbidden of [victim.orgId, victim.orgName, "Approved words", "raw payload"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe("a key only ever unlocks its own tenant", () => {
  it("returns the other organization's data when given the other key, and only then", async () => {
    // The inverse of every test above. Without it, a surface that returned
    // *nothing* would pass the whole file.
    const response = await GET_WIDGET_JSON(
      request(`/api/public/widgets/${intruder.widgetKey}`),
      params(intruder.widgetKey),
    );
    const body = await response.text();

    expect(body).toContain(intruder.marker);
    expect(body).not.toContain(victim.marker);
  });

  it("cannot be pointed at another tenant by any input", () => {
    // Structural rather than behavioural: the resolvers take one opaque string
    // and the loaders take only what those returned. A signature that grew an
    // `organizationId` parameter would be the shape this whole file exists to
    // prevent, and no runtime assertion would notice.
    expect(resolveWidgetByKey).toHaveLength(1);
    expect(loadWidgetContent).toHaveLength(1);
    expect(resolveLocationPageBySlug).toHaveLength(1);
    expect(loadLocationPageContent).toHaveLength(1);
  });
});

describe("the next public surface", () => {
  /** Route files outside the authenticated and auth-only groups. */
  function publicRoutes(dir: string, prefix = ""): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        // `(app)` is behind the session guard in its layout; `(auth)` is the
        // sign-in flow. Neither serves tenant data to a stranger.
        if (entry.name === "(app)" || entry.name === "(auth)") return [];
        return publicRoutes(path, `${prefix}/${entry.name}`);
      }

      return entry.name === "route.ts" || entry.name === "page.tsx"
        ? [`${prefix}/${entry.name}`]
        : [];
    });
  }

  it("fails when one is added, so somebody has to think about this file", () => {
    // Not a style rule. Every entry below was reasoned about — some serve
    // tenant data through a key, some serve none at all — and the point of
    // pinning the list is that the *next* one cannot arrive unexamined.
    expect(publicRoutes("src/app").sort()).toEqual(
      [
        // Serve tenant data to strangers. Swept above.
        "/api/public/widgets/[publicKey]/route.ts",
        "/embed/w/[publicKey]/route.ts",
        "/reviews/[slug]/page.tsx",
        // Serve tenant data to one addressee, by unguessable token. Covered by
        // their own tests in tests/db/collect.test.ts and the notification suite.
        "/c/[slug]/page.tsx",
        "/r/[token]/route.ts",
        "/u/[token]/route.ts",
        "/api/campaigns/[campaignId]/qr/route.ts",
        "/api/public/reviews/route.ts",
        /**
         * Surveys (P4-T2), and why they are in this group rather than the one
         * above. `/s/{code}` takes a token *or* a public slug and renders the
         * question, the business's name and its branch — the same amount of
         * tenant data `/c/{slug}` shows, to somebody who was handed the code.
         * It publishes **no answers**: nothing a respondent wrote is ever read
         * back on a public surface, so there is no pool of other people's words
         * to leak. The two write endpoints resolve their tenant from the code
         * and accept no organization id, and `tests/db/surveys.test.ts` walks
         * them.
         */
        "/s/[code]/page.tsx",
        "/api/public/surveys/route.ts",
        "/api/public/surveys/follow-up/route.ts",
        // Carry no tenant data at all.
        "/api/auth/[...all]/route.ts",
        "/api/connect/[provider]/callback/route.ts",
        "/api/connect/[provider]/start/route.ts",
        "/api/health/route.ts",
        "/api/webhooks/instagram/route.ts",
        /**
         * Stripe's webhook (W1.8). Carries no tenant data *out* — it answers
         * `{received:true}` and nothing else — but it is the one public route
         * that can change what an organization is entitled to, so it is worth
         * saying why that is safe. The `Stripe-Signature` HMAC is verified
         * before the body is parsed, and `applyBillingEvent` takes the
         * organization from metadata *we* set on the subscription rather than
         * from anything a caller can supply. Unsigned or unattributable events
         * are refused and dropped respectively.
         */
        "/api/webhooks/stripe/route.ts",
        "/api/webhooks/whatsapp/route.ts",
        "/embed/widget.js/route.ts",
        "/page.tsx",
        "/sample/page.tsx",
      ].sort(),
    );
  });
});
