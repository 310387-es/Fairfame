import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkSendAllowed, setIysGateway, SESSION_WINDOW_MS } from "@/compliance/gate";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";
import { sendTemplateMessage, sendSessionReply } from "@/messaging/whatsapp";
import type { WhatsAppClient } from "@/connectors/whatsapp/client";

/**
 * The compliance gate (P1b-T3, completed by P1b-T5).
 *
 * The most consequential tests in the repository. Everything else here fails by
 * showing the wrong number on a screen; this fails by putting a message on a
 * stranger's phone that they never agreed to receive — a fineable act under İYS
 * and grounds for Meta to suspend the number.
 *
 * So the shape of these tests is deliberately paranoid: the default path is
 * *refusal*, and every allow requires something to be true. A regression that
 * flipped a default would break most of this file.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

const IYS_ON = { IYS_REQUIRED: true };
const IYS_OFF = { IYS_REQUIRED: false };

/** A gateway that always approves — what T5's real one will sometimes do. */
// These tests are about `check`; uploading is exercised in compliance-iys-upload.
// It throws rather than no-opping so a test that reached it by accident says so.
const noUploads = async (): Promise<never> => {
  throw new Error("This gateway is check-only.");
};

const allowingGateway = {
  name: "test-allow",
  check: async () => "allowed" as const,
  upload: noUploads,
};
const rejectingGateway = {
  name: "test-reject",
  check: async () => "rejected" as const,
  upload: noUploads,
};

type Fixture = { orgId: string; contactId: string };

async function makeFixture(label: string, phone?: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Gate ${label} ${suffix}`, slug: `gate-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [contact] = await getAdminDb()
    .insert(schema.contacts)
    .values({
      organizationId: org.id,
      name: "Mehmet",
      phone: phone ?? `9053200${String(counter++).padStart(5, "0")}`,
      locale: "tr",
    })
    .returning({ id: schema.contacts.id });
  if (!contact) throw new Error("contact insert returned nothing");

  return { orgId: org.id, contactId: contact.id };
}

/**
 * Records the consent that authorises a commercial message.
 *
 * An **İYS** record, not a KVKK one: KVKK consent is permission to process
 * someone's data, İYS consent is permission to message them. Where İYS applies
 * the gate requires the latter, because treating a review form's data-processing
 * tick as marketing permission is the conflation the registry exists to stop.
 *
 * Keyed on the **contact id**, not the phone: `consent_records.contact_ref` is
 * documented as "a pointer to the contact, not the PII itself", and `contacts`
 * is meant to be the single place a number lives so a KVKK erasure is one row.
 */
async function grantConsent(fixture: Fixture, type: "iys" | "kvkk" = "iys"): Promise<void> {
  await getAdminDb()
    .insert(schema.consentRecords)
    .values({
      organizationId: fixture.orgId,
      contactRef: fixture.contactId,
      type,
      channel: type === "iys" ? "message" : null,
      grantedAt: new Date(),
    });
}

async function openWindow(fixture: Fixture, at: Date): Promise<void> {
  await getAdminDb().insert(schema.whatsappConversations).values({
    organizationId: fixture.orgId,
    contactId: fixture.contactId,
    lastInboundAt: at,
  });
}

function check(fixture: Fixture, intent: "commercial" | "service", env = IYS_ON, now?: Date) {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    checkSendAllowed(
      {
        tx,
        organizationId: fixture.orgId,
        contactId: fixture.contactId,
        intent,
        channel: "whatsapp",
        ...(now ? { now } : {}),
      },
      env,
    ),
  );
}

afterEach(() => {
  setIysGateway(null);
});

afterAll(async () => {
  await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  await closeDatabasePools();
});

describe("commercial messages", () => {
  it("refuses when there is no consent record at all", async () => {
    const fixture = await makeFixture("no-consent");
    setIysGateway(allowingGateway);

    // The default is no. Nothing about a contact existing implies they agreed
    // to be messaged.
    expect(await check(fixture, "commercial")).toMatchObject({
      allowed: false,
      reason: "no_consent",
    });
  });

  it("refuses a contact who has opted out, even with consent on file", async () => {
    const fixture = await makeFixture("opted-out");
    await grantConsent(fixture);
    setIysGateway(allowingGateway);

    await getAdminDb()
      .update(schema.contacts)
      .set({ unsubscribedAt: new Date() })
      .where(eq(schema.contacts.id, fixture.contactId));

    // An opt-out supersedes an earlier consent. Someone who said stop has said
    // stop, and a stale consent record does not undo it.
    expect(await check(fixture, "commercial")).toMatchObject({
      allowed: false,
      reason: "opted_out",
    });
  });

  it("refuses when İYS is required and no gateway is wired", async () => {
    const fixture = await makeFixture("no-gateway");
    await grantConsent(fixture);

    // This is the state the product ships in today. T3 built the gate; T5 wires
    // the registry. Until then a commercial send does not happen — which is the
    // whole reason the gate was built before the integration.
    const decision = await check(fixture, "commercial");

    expect(decision).toMatchObject({ allowed: false, reason: "iys_not_configured" });
    expect(decision.allowed === false && decision.detail).toContain("P1b-T5");
  });

  it("refuses when the gateway says no", async () => {
    const fixture = await makeFixture("iys-no");
    await grantConsent(fixture);
    setIysGateway(rejectingGateway);

    expect(await check(fixture, "commercial")).toMatchObject({
      allowed: false,
      reason: "iys_rejected",
    });
  });

  it("allows when consent and the registry both agree", async () => {
    const fixture = await makeFixture("iys-yes");
    await grantConsent(fixture);
    setIysGateway(allowingGateway);

    expect(await check(fixture, "commercial")).toMatchObject({
      allowed: true,
      reason: "consented",
    });
  });

  it("still requires local consent outside Türkiye", async () => {
    const fixture = await makeFixture("no-iys-market");

    // IYS_REQUIRED=false skips the *registry*, not consent. A deployment in
    // another market is not one that may message anyone it likes — and there
    // the KVKK record is the local basis, since there is no İYS to consult.
    expect(await check(fixture, "commercial", IYS_OFF)).toMatchObject({
      allowed: false,
      reason: "no_consent",
    });

    await grantConsent(fixture, "kvkk");
    expect(await check(fixture, "commercial", IYS_OFF)).toMatchObject({ allowed: true });
  });

  it("does not accept a KVKK tick as permission to market", async () => {
    const fixture = await makeFixture("kvkk-not-iys");
    setIysGateway(allowingGateway);

    // Someone who agreed to their data being processed on a review form has not
    // agreed to receive marketing.
    await grantConsent(fixture, "kvkk");

    expect(await check(fixture, "commercial")).toMatchObject({
      allowed: false,
      reason: "no_consent",
    });
  });

  it("treats a withdrawn consent as withdrawn", async () => {
    const fixture = await makeFixture("revoked-consent");
    setIysGateway(allowingGateway);
    await grantConsent(fixture);

    await getAdminDb()
      .update(schema.consentRecords)
      .set({ revokedAt: new Date() })
      .where(eq(schema.consentRecords.organizationId, fixture.orgId));

    // Withdrawal never deletes the row, so a gate that read only `granted_at`
    // would happily message someone who had said stop.
    expect(await check(fixture, "commercial")).toMatchObject({
      allowed: false,
      reason: "opted_out",
    });
  });

  it("refuses a contact belonging to another organization", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");
    await grantConsent(theirs);
    setIysGateway(allowingGateway);

    const decision = await withTenant({ organizationId: mine.orgId }, (tx) =>
      checkSendAllowed(
        {
          tx,
          organizationId: mine.orgId,
          contactId: theirs.contactId,
          intent: "commercial",
          channel: "whatsapp",
        },
        IYS_ON,
      ),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "unknown_contact" });
  });
});

describe("the 24-hour customer service window", () => {
  it("refuses a service reply with no inbound message", async () => {
    const fixture = await makeFixture("no-session");

    expect(await check(fixture, "service")).toMatchObject({
      allowed: false,
      reason: "no_open_session",
    });
  });

  it("allows a reply inside the window, with no consent record", async () => {
    const fixture = await makeFixture("open-session");
    await openWindow(fixture, new Date());

    // The customer started the conversation and is waiting for an answer.
    // Requiring marketing consent to reply would be the wrong reading of both
    // Meta's rule and İYS.
    expect(await check(fixture, "service")).toMatchObject({
      allowed: true,
      reason: "open_session",
    });
  });

  it("refuses once the window has closed", async () => {
    const fixture = await makeFixture("stale-session");
    const now = new Date();
    await openWindow(fixture, new Date(now.getTime() - SESSION_WINDOW_MS - 60_000));

    expect(await check(fixture, "service", IYS_ON, now)).toMatchObject({
      allowed: false,
      reason: "no_open_session",
    });
  });

  it("refuses a service reply to someone who opted out", async () => {
    const fixture = await makeFixture("session-optout");
    await openWindow(fixture, new Date());
    await getAdminDb()
      .update(schema.contacts)
      .set({ unsubscribedAt: new Date() })
      .where(eq(schema.contacts.id, fixture.contactId));

    // An opt-out beats an open window too.
    expect(await check(fixture, "service")).toMatchObject({
      allowed: false,
      reason: "opted_out",
    });
  });

  it("does not let an outbound message open its own window", async () => {
    const fixture = await makeFixture("self-open");

    await getAdminDb().insert(schema.whatsappConversations).values({
      organizationId: fixture.orgId,
      contactId: fixture.contactId,
      // Only `last_outbound_at` — we messaged them, they did not message us.
      lastOutboundAt: new Date(),
    });

    // The entire point of the rule. A business that could open its own window
    // would have no window at all.
    expect(await check(fixture, "service")).toMatchObject({
      allowed: false,
      reason: "no_open_session",
    });
  });
});

describe("the send path", () => {
  /** Records what it was asked to send, and never touches a network. */
  function recordingClient(): WhatsAppClient & { sent: unknown[] } {
    const sent: unknown[] = [];
    return {
      sent,
      async sendTemplate(input) {
        sent.push(input);
        return { ok: true, messageId: "wamid.test", waId: null };
      },
      async sendText(input) {
        sent.push(input);
        return { ok: true, messageId: "wamid.test", waId: null };
      },
      async markRead() {},
    };
  }

  it("does not reach the client when the gate refuses", async () => {
    const fixture = await makeFixture("gate-blocks-send");
    const client = recordingClient();

    const outcome = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      sendTemplateMessage({
        tx,
        organizationId: fixture.orgId,
        contactId: fixture.contactId,
        template: "review_request_v1",
        values: ["Mehmet", "Kadıköy", "https://r.example/a"],
        client,
      }),
    );

    // The gate is checked in the send function, not the client — a client that
    // enforced consent would be bypassable by constructing another one.
    expect(outcome.ok).toBe(false);
    expect(client.sent).toHaveLength(0);
  });

  it("sends once the gate allows it", async () => {
    const fixture = await makeFixture("gate-allows-send");
    await grantConsent(fixture);
    setIysGateway(allowingGateway);

    const client = recordingClient();
    const outcome = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      sendTemplateMessage({
        tx,
        organizationId: fixture.orgId,
        contactId: fixture.contactId,
        template: "review_request_v1",
        values: ["Mehmet", "Kadıköy", "https://r.example/a"],
        client,
      }),
    );

    expect(outcome).toMatchObject({ ok: true, messageId: "wamid.test" });
    expect(client.sent).toHaveLength(1);
  });

  it("sends a session reply in the contact's own language", async () => {
    const fixture = await makeFixture("session-send");
    await openWindow(fixture, new Date());

    const client = recordingClient();
    const outcome = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      sendSessionReply({
        tx,
        organizationId: fixture.orgId,
        contactId: fixture.contactId,
        body: "Merhaba, yardımcı olalım.",
        client,
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(client.sent[0]).toMatchObject({ body: "Merhaba, yardımcı olalım." });
  });

  it("reports a refusal rather than throwing", async () => {
    const fixture = await makeFixture("refusal-shape");

    const outcome = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      sendTemplateMessage({
        tx,
        organizationId: fixture.orgId,
        contactId: fixture.contactId,
        template: "review_request_v1",
        values: ["a", "b", "c"],
        client: recordingClient(),
      }),
    );

    // "We declined to message this person" is an outcome the caller must
    // record, not an exception to swallow.
    expect(outcome).toMatchObject({ ok: false, refusal: "no_consent" });
    expect(outcome.ok === false && outcome.reason).toBeTruthy();
  });
});
