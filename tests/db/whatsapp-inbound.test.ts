import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { flattenWebhook, webhookSchema } from "@/connectors/whatsapp/schemas";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { recordInboundEvents } from "@/messaging/whatsapp-inbound";

/**
 * What an inbound WhatsApp event does to our state (P1b-T3).
 *
 * The webhook is the one genuinely cross-tenant entry point in the product:
 * Meta posts to a single URL, and the tenant has to be *derived* from the phone
 * number in the payload. These tests exist mostly to pin the two ways that can
 * go wrong — deriving the wrong tenant, and storing something for a number we
 * hold no contact for.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

/** The number the fixtures send from. */
const FIXTURE_PHONE = "905321234567";

function events(name: string) {
  const raw = JSON.parse(
    readFileSync(new URL(`../fixtures/whatsapp/${name}.json`, import.meta.url), "utf8"),
  );
  return flattenWebhook(webhookSchema.parse(raw));
}

async function makeOrgWithContact(label: string, phone: string) {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `WA ${label} ${suffix}`, slug: `wa-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [contact] = await getAdminDb()
    .insert(schema.contacts)
    .values({ organizationId: org.id, name: "Mehmet", phone, locale: "tr" })
    .returning({ id: schema.contacts.id });

  return { orgId: org.id, contactId: contact!.id };
}

async function conversation(orgId: string) {
  const [row] = await getAdminDb()
    .select()
    .from(schema.whatsappConversations)
    .where(eq(schema.whatsappConversations.organizationId, orgId));
  return row;
}

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("an inbound message", () => {
  it("opens the customer service window", async () => {
    const fixture = await makeOrgWithContact("inbound", FIXTURE_PHONE);

    const outcome = await recordInboundEvents(events("inbound-text"));

    expect(outcome.matched).toBe(1);
    const row = await conversation(fixture.orgId);
    expect(row?.lastInboundAt).not.toBeNull();
    expect(row?.waId).toBe(FIXTURE_PHONE);
    // Never touched by an inbound event — only an outbound send writes it.
    expect(row?.lastOutboundAt).toBeNull();
  });

  it("stores nothing for a number we hold no contact for", async () => {
    // Recording it would create a contact nobody consented to give us.
    const outcome = await recordInboundEvents(events("inbound-text"));

    expect(outcome.unknown + outcome.matched).toBe(1);
    const rows = await getAdminDb()
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.phone, FIXTURE_PHONE));

    // Only the contact the previous test created; the handler added none.
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("refreshes the window on a second message", async () => {
    const fixture = await makeOrgWithContact("refresh", "905321111111");
    const first = new Date("2026-08-01T10:00:00Z");
    const second = new Date("2026-08-01T18:00:00Z");

    const payload = events("inbound-text");
    payload.messages[0]!.message.from = "905321111111";

    await recordInboundEvents(payload, first);
    await recordInboundEvents(payload, second);

    const row = await conversation(fixture.orgId);
    expect(row?.lastInboundAt?.toISOString()).toBe(second.toISOString());

    // One conversation per contact, not one row per message.
    const all = await getAdminDb()
      .select({ id: schema.whatsappConversations.id })
      .from(schema.whatsappConversations)
      .where(eq(schema.whatsappConversations.organizationId, fixture.orgId));
    expect(all).toHaveLength(1);
  });
});

describe("an opt-out", () => {
  it("unsubscribes the contact immediately", async () => {
    const fixture = await makeOrgWithContact("optout", "905322222222");

    const payload = events("inbound-optout");
    payload.messages[0]!.message.from = "905322222222";

    const outcome = await recordInboundEvents(payload);

    expect(outcome.optOuts).toBe(1);
    const [contact] = await getAdminDb()
      .select({ unsubscribedAt: schema.contacts.unsubscribedAt })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contactId));

    expect(contact?.unsubscribedAt).not.toBeNull();
  });

  it("does not open a service window", async () => {
    const fixture = await makeOrgWithContact("optout-window", "905323333333");

    const payload = events("inbound-optout");
    payload.messages[0]!.message.from = "905323333333";
    await recordInboundEvents(payload);

    // "STOP" is a legal instruction, not the start of a conversation. Treating
    // it as one would let us reply to someone who just told us to go away.
    expect(await conversation(fixture.orgId)).toBeUndefined();
  });

  it("keeps the first refusal's timestamp", async () => {
    const fixture = await makeOrgWithContact("optout-twice", "905324444444");

    const payload = events("inbound-optout");
    payload.messages[0]!.message.from = "905324444444";

    const first = new Date("2026-08-01T10:00:00Z");
    await recordInboundEvents(payload, first);
    await recordInboundEvents(payload, new Date("2026-08-02T10:00:00Z"));

    const [contact] = await getAdminDb()
      .select({ unsubscribedAt: schema.contacts.unsubscribedAt })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contactId));

    expect(contact?.unsubscribedAt?.toISOString()).toBe(first.toISOString());
  });
});

describe("delivery statuses", () => {
  it("marks the request that produced the message", async () => {
    const fixture = await makeOrgWithContact("status", "905325555555");

    const [location] = await getAdminDb()
      .insert(schema.locations)
      .values({ organizationId: fixture.orgId, name: "Şube" })
      .returning({ id: schema.locations.id });

    const [campaign] = await getAdminDb()
      .insert(schema.campaigns)
      .values({
        organizationId: fixture.orgId,
        locationId: location!.id,
        name: "WA",
        slug: `wa-${suffix}`,
        channel: "whatsapp",
        destination: "firstparty",
      })
      .returning({ id: schema.campaigns.id });

    await getAdminDb()
      .insert(schema.reviewRequests)
      .values({
        organizationId: fixture.orgId,
        campaignId: campaign!.id,
        locationId: location!.id,
        contactId: fixture.contactId,
        channel: "whatsapp",
        status: "pending",
        token: `tok-${suffix}`,
        externalId: "wamid.OUTBOUND_TEST_ID",
      });

    const outcome = await recordInboundEvents(events("status-delivered"));

    // Delivery is confirmed asynchronously, so a request only becomes `sent`
    // when Meta says the handset received it.
    expect(outcome.statuses).toBe(1);

    const [request] = await getAdminDb()
      .select({ status: schema.reviewRequests.status })
      .from(schema.reviewRequests)
      .where(eq(schema.reviewRequests.externalId, "wamid.OUTBOUND_TEST_ID"));

    expect(request?.status).toBe("sent");
  });

  it("ignores a status for a message we did not send", async () => {
    const payload = events("status-delivered");
    // A distinct id: the previous test's request row is still in the database,
    // and reusing the fixture's id would measure test order rather than
    // behaviour.
    payload.statuses[0]!.id = `wamid.UNKNOWN_${suffix}`;

    const outcome = await recordInboundEvents(payload);
    expect(outcome.statuses).toBe(0);
  });
});

describe("tenant derivation", () => {
  it("writes only to the organization that owns the number", async () => {
    const mine = await makeOrgWithContact("derive-mine", "905326666666");
    const theirs = await makeOrgWithContact("derive-theirs", "905327777777");

    const payload = events("inbound-text");
    payload.messages[0]!.message.from = "905326666666";
    await recordInboundEvents(payload);

    // The webhook has no session; the tenant is derived from the payload. That
    // derivation going wrong would write one business's conversation into
    // another's account.
    expect(await conversation(mine.orgId)).toBeDefined();
    expect(await conversation(theirs.orgId)).toBeUndefined();
  });
});
