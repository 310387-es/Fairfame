import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordIysConsent } from "@/compliance/consent";
import { setIysGateway } from "@/compliance/gate";
import { createLocalGateway } from "@/compliance/iys-gateway";
import { sendReviewRequests } from "@/collect/requests";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * Review requests on WhatsApp and SMS (W2.2).
 *
 * Until now `prepareRequests` hardcoded `channel: "email"` and refused
 * everything else with "needs its connector and the İYS consent gate". Both now
 * exist, so the refusal moved from a list to the gate — and that move is what
 * these tests are about. A message on either channel is still stopped in every
 * environment; what changed is that it is stopped **for a stated reason, at the
 * moment it would leave**, rather than by a schema that would not let a
 * business describe the campaign at all.
 *
 * The email path is asserted alongside deliberately: it does *not* go through
 * the gate (a pre-existing gap, flagged in `CLAUDE.md`), and a test that only
 * covered the new channels would let somebody "tidy" that difference away
 * without noticing they had stopped every review-request email in production.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

type Fixture = {
  orgId: string;
  locationId: string;
  /** Has a phone and a live local consent record. */
  willing: string;
  /** Has a phone and no consent at all. */
  unconsented: string;
  /** Has consent but no phone number to send to. */
  numberless: string;
};

async function makeFixture(): Promise<Fixture> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `ReqCh ${suffix}`, slug: `reqch-${suffix}`, locale: "tr" })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await db
    .insert(schema.locations)
    .values({ organizationId: org.id, name: "Kadıköy Şubesi", locale: "tr" })
    .returning({ id: schema.locations.id });
  if (!location) throw new Error("location insert returned nothing");

  const contacts = await db
    .insert(schema.contacts)
    .values([
      { organizationId: org.id, name: "İzinli Kişi", phone: `905310${suffix}` },
      { organizationId: org.id, name: "İzinsiz Kişi", phone: `905320${suffix}` },
      { organizationId: org.id, name: "Numarasız Kişi", email: `no-phone-${suffix}@example.test` },
    ])
    .returning({ id: schema.contacts.id });

  const fixture: Fixture = {
    orgId: org.id,
    locationId: location.id,
    willing: contacts[0]!.id,
    unconsented: contacts[1]!.id,
    numberless: contacts[2]!.id,
  };

  await withTenant({ organizationId: org.id }, async (tx) => {
    for (const contactId of [fixture.willing, fixture.numberless]) {
      await recordIysConsent({
        tx,
        organizationId: org.id,
        contactRef: contactId,
        channel: "message",
        source: "web_form",
        proofRef: "test",
      });
    }
  });

  return fixture;
}

let campaignSeq = 0;

async function makeCampaign(
  fixture: Fixture,
  channel: "email" | "whatsapp" | "sms",
): Promise<string> {
  const [campaign] = await getAdminDb()
    .insert(schema.campaigns)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      name: `${channel} kampanyası`,
      channel,
      status: "active",
      // Unique per call: a campaign slug is a public URL, so several campaigns
      // on the same channel cannot share one.
      slug: `reqch-${channel}-${suffix}-${campaignSeq++}`,
    })
    .returning({ id: schema.campaigns.id });
  if (!campaign) throw new Error("campaign insert returned nothing");
  return campaign.id;
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = await makeFixture();
});

afterAll(async () => {
  setIysGateway(null);
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("a review request on WhatsApp", () => {
  it("is refused, by the gate, when no consent registry is wired", async () => {
    // The default state of every deployment, and the correct one before
    // go-live. What matters is *which* refusal: `iys_not_configured` is the
    // operator's problem, and it is a different sentence from "this person
    // said no".
    setIysGateway(null);
    const campaignId = await makeCampaign(fixture, "whatsapp");

    const outcome = await sendReviewRequests({
      organizationId: fixture.orgId,
      actorUserId: null,
      campaignId,
      recipients: [{ contactId: fixture.willing, name: null }],
    });

    expect(outcome.sent).toBe(0);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures[0]?.reason.length).toBeGreaterThan(0);
  });

  it("is refused for somebody with no permission, even with a registry wired", async () => {
    // Granted-first would prove nothing about consent; this contact has a phone
    // and no record, so the only thing that can stop it is the permission check.
    setIysGateway(createLocalGateway("test"));
    const campaignId = await makeCampaign(fixture, "whatsapp");

    const outcome = await sendReviewRequests({
      organizationId: fixture.orgId,
      actorUserId: null,
      campaignId,
      recipients: [{ contactId: fixture.unconsented, name: null }],
    });

    expect(outcome.sent).toBe(0);
    expect(outcome.failed).toBe(1);
  });

  it("records the request against the contact and the channel it was meant for", async () => {
    // Even a refused send leaves the row that says what was attempted: "why did
    // this customer never hear from us" is a question support has to answer.
    setIysGateway(createLocalGateway("test"));
    const campaignId = await makeCampaign(fixture, "whatsapp");

    await sendReviewRequests({
      organizationId: fixture.orgId,
      actorUserId: null,
      campaignId,
      recipients: [{ contactId: fixture.willing, name: null }],
    });

    const [row] = await getAdminDb()
      .select({
        channel: schema.reviewRequests.channel,
        contactId: schema.reviewRequests.contactId,
        status: schema.reviewRequests.status,
      })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.campaignId, campaignId));

    expect(row?.channel).toBe("whatsapp");
    expect(row?.contactId).toBe(fixture.willing);
  });

  it("skips a contact with no number rather than failing the send", async () => {
    // A missing number is a fact about the record, not a transport failure, and
    // the screen should be able to say "these three have no phone number"
    // instead of showing three identical errors.
    setIysGateway(createLocalGateway("test"));
    const campaignId = await makeCampaign(fixture, "whatsapp");

    const outcome = await sendReviewRequests({
      organizationId: fixture.orgId,
      actorUserId: null,
      campaignId,
      recipients: [{ contactId: fixture.numberless, name: null }],
    });

    expect(outcome.sent).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.skipped).toEqual([{ label: "Numarasız Kişi", reason: "no_address" }]);
  });
});

describe("a review request on SMS", () => {
  it("is refused while no gateway is configured", async () => {
    // `SMS_GATEWAY` defaults to `none`, which refuses. Nothing in this product
    // has ever reached a phone by SMS, and the test says so rather than
    // asserting a success that would only pass because a mock accepted it.
    setIysGateway(createLocalGateway("test"));
    const campaignId = await makeCampaign(fixture, "sms");

    const outcome = await sendReviewRequests({
      organizationId: fixture.orgId,
      actorUserId: null,
      campaignId,
      recipients: [{ contactId: fixture.willing, name: null }],
    });

    expect(outcome.sent).toBe(0);
    expect(outcome.failed).toBe(1);
  });
});

describe("a review request by email", () => {
  it("still sends without a consent registry", async () => {
    // The pre-existing gap, pinned deliberately. Routing email through the gate
    // would stop every review-request email in every environment without a
    // registry — which is all of them — so it is flagged rather than closed. A
    // test that only covered the new channels would let somebody "tidy" this
    // difference away and take the feature down.
    setIysGateway(null);
    const campaignId = await makeCampaign(fixture, "email");

    const outcome = await sendReviewRequests({
      organizationId: fixture.orgId,
      actorUserId: null,
      campaignId,
      recipients: [{ email: `alici-${suffix}@example.test`, name: "Alıcı" }],
    });

    expect(outcome.sent).toBe(1);
    expect(outcome.failed).toBe(0);
  });
});
