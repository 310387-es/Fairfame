import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCollectionFunnel } from "@/collect/funnel";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * The funnel, read from the database (W4.5).
 *
 * The interesting half is the **walk-ins**: a review that arrived through a QR
 * code with nobody asked. On a Turkish café that is frequently the largest
 * number on the screen, and the two ways to get it wrong are both quiet —
 * counting it as a 0%-conversion channel, or double-counting a review we *did*
 * ask for as a walk-in as well.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

let org: { id: string; locationId: string; campaignId: string; contactId: string };
let other: { id: string; locationId: string; campaignId: string; contactId: string };

const NOW = new Date("2026-08-06T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);

async function makeOrg(label: string) {
  const db = getAdminDb();

  const [created] = await db
    .insert(schema.organizations)
    .values({ name: `Funnel ${label} ${suffix}`, slug: `funnel-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgIds.push(created!.id);

  const [location] = await db
    .insert(schema.locations)
    .values({ organizationId: created!.id, name: "Kadıköy Şubesi" })
    .returning({ id: schema.locations.id });

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      organizationId: created!.id,
      locationId: location!.id,
      name: "Yorum daveti",
      slug: `f-${label}-${suffix}`,
    })
    .returning({ id: schema.campaigns.id });

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: created!.id,
      name: "Mehmet Demir",
      email: `m-${label}-${suffix}@e.com`,
    })
    .returning({ id: schema.contacts.id });

  return {
    id: created!.id,
    locationId: location!.id,
    campaignId: campaign!.id,
    contactId: contact!.id,
  };
}

type RequestSeed = {
  channel: "email" | "sms" | "whatsapp" | "link";
  sent?: Date | null;
  opened?: Date | null;
  submitted?: Date | null;
};

async function addRequests(target: typeof org, seeds: RequestSeed[]) {
  const db = getAdminDb();

  await db.insert(schema.reviewRequests).values(
    seeds.map((seed, index) => ({
      organizationId: target.id,
      campaignId: target.campaignId,
      locationId: target.locationId,
      contactId: target.contactId,
      channel: seed.channel,
      status: "sent" as const,
      token: `tok-${suffix}-${target.id.slice(0, 4)}-${index}-${crypto.randomUUID().slice(0, 6)}`,
      createdAt: daysAgo(10),
      sentAt: seed.sent ?? daysAgo(10),
      openedAt: seed.opened ?? null,
      submittedAt: seed.submitted ?? null,
    })),
  );
}

async function addFirstPartyReview(target: typeof org, at: Date) {
  const db = getAdminDb();

  await db.insert(schema.reviews).values({
    organizationId: target.id,
    locationId: target.locationId,
    source: "firstparty",
    sourceReviewId: `fp-${crypto.randomUUID()}`,
    authorName: "Ayşe Yılmaz",
    rating: 5,
    text: "Harikaydı.",
    postedAt: at,
    createdAt: at,
    rawPayload: {},
  });
}

beforeAll(async () => {
  org = await makeOrg("alpha");
  other = await makeOrg("beta");

  await addRequests(org, [
    // Email: three asked, two opened, one reviewed.
    { channel: "email", opened: daysAgo(9), submitted: daysAgo(9) },
    { channel: "email", opened: daysAgo(9) },
    { channel: "email" },
    // WhatsApp: two asked, both reviewed.
    { channel: "whatsapp", opened: daysAgo(8), submitted: daysAgo(8) },
    { channel: "whatsapp", opened: daysAgo(8), submitted: daysAgo(8) },
    // A `link` campaign has nothing to deliver and must not become a channel.
    { channel: "link", opened: daysAgo(7), submitted: daysAgo(7) },
  ]);

  // Two first-party reviews at the moment two requests were submitted, and one
  // that nobody asked for — the walk-in.
  await addFirstPartyReview(org, daysAgo(9));
  await addFirstPartyReview(org, daysAgo(8));
  await addFirstPartyReview(org, daysAgo(2));

  // The other organization has the same shapes, so a leak reads as a wrong count.
  await addRequests(other, [{ channel: "email", opened: daysAgo(9), submitted: daysAgo(9) }]);
  await addFirstPartyReview(other, daysAgo(2));
});

afterAll(async () => {
  const db = getAdminDb();
  if (orgIds.length > 0) {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

const load = () =>
  withTenant({ organizationId: org.id }, (tx) => loadCollectionFunnel(tx, org.id, NOW));

describe("the totals", () => {
  it("counts every channel, including the ones that are not a message", () => {
    // `link` rows still happened and still converted; they are excluded from
    // the *channel comparison*, not from the funnel.
    return load().then((funnel) => {
      expect(funnel.total).toEqual({ sent: 6, opened: 5, submitted: 4 });
    });
  });

  it("sees none of the other organization's requests", async () => {
    const funnel = await withTenant({ organizationId: other.id }, (tx) =>
      loadCollectionFunnel(tx, other.id, NOW),
    );

    expect(funnel.total.sent).toBe(1);
  });
});

describe("the channel comparison", () => {
  it("leaves out `link`, which has nothing to deliver", async () => {
    const { byChannel } = await load();
    expect(byChannel.map((row) => row.channel)).not.toContain("link");
  });

  it("puts the busiest channel first", async () => {
    // On a business that has tried three, the one it actually uses should be
    // the row the eye lands on.
    const { byChannel } = await load();
    expect(byChannel[0]?.channel).toBe("email");
    expect(byChannel[0]?.sent).toBe(3);
  });

  it("keeps each channel's own conversion separate", async () => {
    const { byChannel } = await load();
    const whatsapp = byChannel.find((row) => row.channel === "whatsapp");

    expect(whatsapp).toMatchObject({ sent: 2, opened: 2, submitted: 2 });
  });
});

describe("walk-ins", () => {
  it("counts a review nobody asked for", async () => {
    /**
     * The number this whole module exists to get right. A QR code on a table is
     * not a send — and on a café it is frequently the largest figure on screen,
     * which is exactly why it must not be filed under a column reading 0%.
     */
    const { walkIn } = await load();
    expect(walkIn).toBe(1);
  });

  it("does not count a review we did ask for", async () => {
    // The two first-party reviews that landed when a request was submitted are
    // the requests' own conversions; counting them again would inflate the one
    // figure a business cannot check by hand.
    const { walkIn, total } = await load();
    expect(walkIn + total.submitted).toBe(5);
  });

  it("sees none of the other organization's walk-ins", async () => {
    const funnel = await withTenant({ organizationId: other.id }, (tx) =>
      loadCollectionFunnel(tx, other.id, NOW),
    );

    expect(funnel.walkIn).toBe(1);
  });
});
