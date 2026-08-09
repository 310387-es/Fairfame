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

/** The phone number id the fixtures are addressed to. */
const FIXTURE_PHONE_ID = "106540352242922";

/**
 * An organization that owns the number the message was sent *to*, and no
 * contact for whoever sent it. `external_id` is what makes the tenant a lookup
 * rather than a guess (A22-C2).
 */
async function makeOrgWithChannel(label: string, phoneNumberId: string) {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `WA ${label} ${suffix}`, slug: `wa-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  await getAdminDb().insert(schema.channelConnections).values({
    organizationId: org.id,
    channel: "whatsapp",
    status: "active",
    externalId: phoneNumberId,
    displayName: "WhatsApp Business",
  });

  return { orgId: org.id };
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

  it("refreshes the window on a second message", async () => {
    const fixture = await makeOrgWithContact("refresh", "905321111111");
    const first = new Date("2026-08-01T10:00:00Z");
    const second = new Date("2026-08-01T18:00:00Z");

    const payload = events("inbound-text");
    payload.messages[0]!.message.from = "905321111111";

    await recordInboundEvents(payload, first);

    // A *different* message, which is what this test is about. Replaying the
    // same one is a redelivery, and since P4-T3 that is handled differently —
    // see the test below. Before the message log existed the two were
    // indistinguishable, so this fixture was reused for both.
    const again = events("inbound-text");
    again.messages[0]!.message.from = "905321111111";
    again.messages[0]!.message.id = "wamid.second-message";
    await recordInboundEvents(again, second);

    const row = await conversation(fixture.orgId);
    expect(row?.lastInboundAt?.toISOString()).toBe(second.toISOString());

    // One conversation per contact, not one row per message.
    const all = await getAdminDb()
      .select({ id: schema.whatsappConversations.id })
      .from(schema.whatsappConversations)
      .where(eq(schema.whatsappConversations.organizationId, fixture.orgId));
    expect(all).toHaveLength(1);
  });

  it("does not move the window when Meta redelivers the same message", async () => {
    /**
     * Meta says it may deliver a webhook more than once. `last_inbound_at` is
     * the timestamp the 24-hour reply window is measured from — a legal fact
     * about when the customer wrote — so a redelivery must not advance it, or a
     * business would get a fresh day to send free text every time Meta retried.
     */
    const fixture = await makeOrgWithContact("redeliver", "905321111112");
    const first = new Date("2026-08-01T10:00:00Z");
    const retry = new Date("2026-08-01T18:00:00Z");

    const payload = events("inbound-text");
    payload.messages[0]!.message.from = "905321111112";

    const initial = await recordInboundEvents(payload, first);
    const repeat = await recordInboundEvents(payload, retry);

    expect(initial.matched).toBe(1);
    expect(initial.duplicates).toBe(0);
    expect(repeat.duplicates).toBe(1);

    const row = await conversation(fixture.orgId);
    expect(row?.lastInboundAt?.toISOString()).toBe(first.toISOString());

    // And the thread shows the customer speaking once, because they did.
    const stored = await getAdminDb()
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.organizationId, fixture.orgId));
    expect(stored).toHaveLength(1);
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

/**
 * A22-C2 — somebody writing in for the first time.
 *
 * Its own group because every other fixture in this file deliberately shares
 * `FIXTURE_PHONE`, and the case here is precisely a number no contact holds —
 * so the shared one is cleared first rather than a second fixture being
 * invented that would drift from the payload.
 */
describe("a message from a number we do not hold", () => {
  async function forgetFixturePhone() {
    await getAdminDb().delete(schema.contacts).where(eq(schema.contacts.phone, FIXTURE_PHONE));
  }

  /**
   * A22-C2 — a stranger writing in is recorded, and granted nothing.
   *
   * This used to drop the message entirely, on the reasoning that recording it
   * "would create a contact nobody consented to give us". That conflates two
   * things the product is otherwise careful to keep apart: holding a record,
   * and having permission to send. A customer who writes to a café's WhatsApp
   * handed over their number on purpose, and the café never seeing the message
   * is the worse outcome for both of them.
   *
   * What must not change is the second half — see the consent assertion below.
   */
  it("records somebody who wrote to us first, when we can say which business", async () => {
    await forgetFixturePhone();
    const fixture = await makeOrgWithChannel("unknown-number", FIXTURE_PHONE_ID);

    const outcome = await recordInboundEvents(events("inbound-text"));

    expect(outcome.created).toBe(1);

    const [contact] = await getAdminDb()
      .select({ id: schema.contacts.id, organizationId: schema.contacts.organizationId })
      .from(schema.contacts)
      .where(eq(schema.contacts.phone, FIXTURE_PHONE));

    expect(contact?.organizationId).toBe(fixture.orgId);

    // The whole point: a record, and no permission. `checkSendAllowed` still
    // refuses every commercial message to them.
    const consents = await getAdminDb()
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.contactRef, contact!.id));

    expect(consents).toEqual([]);
  });

  it("stores nothing when it cannot say which business was written to", async () => {
    await forgetFixturePhone();
    await getAdminDb()
      .delete(schema.channelConnections)
      .where(eq(schema.channelConnections.externalId, FIXTURE_PHONE_ID));

    // No channel connection carries this `phone_number_id`, so there is no
    // honest answer to "whose contact is this" — and an inference would be a
    // stranger's number in somebody else's contact list.
    const outcome = await recordInboundEvents(events("inbound-text"));

    expect(outcome.created).toBe(0);
    expect(outcome.unknown).toBe(1);
  });
});
