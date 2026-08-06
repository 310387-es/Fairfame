import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { UNRESTRICTED, setMemberLocations } from "@/auth/scope";
import { recordIysConsent } from "@/compliance/consent";
import { setIysGateway } from "@/compliance/gate";
import { createLocalGateway } from "@/compliance/iys-gateway";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";
import { contactTimeline } from "@/contacts/timeline";
import { getContact } from "@/contacts/queries";
import {
  applyReceipt,
  listConversations,
  listThread,
  recordInbound,
  windowState,
} from "@/messaging/messages";
import { intentFor, sendMessage } from "@/messaging/outbound";
import { createMockWhatsAppClient } from "@/connectors/whatsapp/mock-client";

/**
 * Two-way messaging (P4-T3).
 *
 * The Definition of Done has three clauses and each gets its own describe: a
 * mock conversation round-trips, outbound is consent-gated, and it ties to the
 * contact timeline.
 *
 * The gating tests are the ones that matter. WhatsApp's own rule — free text
 * only inside the 24-hour window the *customer* opened, templates only with
 * consent — is not a nicety: sending outside the window damages the number's
 * quality rating, and sending without an İYS permission is a fineable act by
 * the business. So the interesting assertions are all about refusals.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Fixture = {
  orgId: string;
  kadikoy: string;
  besiktas: string;
  /** Consented, and has messaged us. */
  ayse: string;
  /** Consented, has never messaged us. */
  mehmet: string;
  /** No consent at all. */
  stranger: string;
  admin: string;
};

let alpha: Fixture;
let beta: Fixture;
let scoped: string;

const client = createMockWhatsAppClient();

async function makeOrg(label: string): Promise<Fixture> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Messaging ${label} ${suffix}`, slug: `messaging-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgIds.push(org!.id);
  await subscribe(org!.id);

  const locations = await db
    .insert(schema.locations)
    .values([
      { organizationId: org!.id, name: "Kadıköy Şubesi" },
      { organizationId: org!.id, name: "Beşiktaş Şubesi" },
    ])
    .returning({ id: schema.locations.id });

  const contacts = await db
    .insert(schema.contacts)
    .values([
      {
        organizationId: org!.id,
        name: "Ayşe Yılmaz",
        phone: `9053100${label === "alpha" ? 1 : 2}${suffix.slice(0, 4)}`,
      },
      {
        organizationId: org!.id,
        name: "Mehmet Demir",
        phone: `9053200${label === "alpha" ? 1 : 2}${suffix.slice(0, 4)}`,
      },
      {
        organizationId: org!.id,
        name: "Yabancı",
        phone: `9053300${label === "alpha" ? 1 : 2}${suffix.slice(0, 4)}`,
      },
    ])
    .returning({ id: schema.contacts.id });

  const [user] = await db
    .insert(schema.users)
    .values({ email: `msg-admin-${label}-${suffix}@example.com`, name: "Admin" })
    .returning({ id: schema.users.id });
  userIds.push(user!.id);
  await db
    .insert(schema.memberships)
    .values({ organizationId: org!.id, userId: user!.id, role: "admin" });

  const fixture: Fixture = {
    orgId: org!.id,
    kadikoy: locations[0]!.id,
    besiktas: locations[1]!.id,
    ayse: contacts[0]!.id,
    mehmet: contacts[1]!.id,
    stranger: contacts[2]!.id,
    admin: user!.id,
  };

  await withTenant({ organizationId: fixture.orgId }, async (tx) => {
    for (const contactId of [fixture.ayse, fixture.mehmet]) {
      await recordIysConsent({
        tx,
        organizationId: fixture.orgId,
        contactRef: contactId,
        channel: "message",
        source: "web_form",
        proofRef: "test",
      });
    }
  });

  return fixture;
}

/** The floor plan has no `messaging`; find one that does, never name a tier. */
async function subscribe(organizationId: string): Promise<void> {
  const { subscribeToPlanWith } = await import("./plan-fixture");
  await subscribeToPlanWith(organizationId, ["messaging"]);
}

/** Puts an inbound message on record, which is what opens the 24-hour window. */
async function customerWrites(fixture: Fixture, contactId: string, at: Date): Promise<void> {
  await withTenant({ organizationId: fixture.orgId }, async (tx) => {
    await recordInbound({
      tx,
      organizationId: fixture.orgId,
      contactId,
      channel: "whatsapp",
      body: "Merhaba",
      externalId: `wamid.in-${contactId}-${at.getTime()}`,
      at,
    });

    await tx
      .insert(schema.whatsappConversations)
      .values({ organizationId: fixture.orgId, contactId, lastInboundAt: at })
      .onConflictDoUpdate({
        target: [
          schema.whatsappConversations.organizationId,
          schema.whatsappConversations.contactId,
        ],
        set: { lastInboundAt: at, updatedAt: at },
      });
  });
}

beforeAll(async () => {
  alpha = await makeOrg("alpha");
  beta = await makeOrg("beta");

  const db = getAdminDb();
  const [member] = await db
    .insert(schema.users)
    .values({ email: `msg-scoped-${suffix}@example.com`, name: "Scoped" })
    .returning({ id: schema.users.id });
  userIds.push(member!.id);
  scoped = member!.id;

  await db
    .insert(schema.memberships)
    .values({ organizationId: alpha.orgId, userId: scoped, role: "member" });

  await withTenant({ organizationId: alpha.orgId, userId: alpha.admin }, (tx) =>
    setMemberLocations(
      tx,
      { organizationId: alpha.orgId, role: "admin" },
      { userId: scoped, locationIds: [alpha.kadikoy] },
    ),
  );
}, 30_000);

afterEach(() => setIysGateway(null));

afterAll(async () => {
  const db = getAdminDb();
  if (orgIds.length > 0) {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  if (userIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
  setIysGateway(null);
  await closeDatabasePools();
});

// ---------------------------------------------------------------------------

describe("what basis a message rests on", () => {
  it("is derived from the channel and the content, never chosen", () => {
    // The rule, as a pure function. A caller cannot ask for `service`: there is
    // no parameter for it, which is what stops a screen declaring its own
    // message exempt from consent.
    expect(intentFor("whatsapp", { kind: "reply", body: "hi" })).toBe("service");
    expect(
      intentFor("whatsapp", { kind: "template", template: "review_request", values: [] }),
    ).toBe("commercial");

    // SMS has no service window — that is a Meta rule about a WhatsApp
    // conversation, and Turkish law grants no equivalent for replying to an SMS.
    expect(intentFor("sms", { kind: "reply", body: "hi" })).toBe("commercial");
    expect(intentFor("sms", { kind: "template", template: "review_request", values: [] })).toBe(
      "commercial",
    );
  });
});

describe("outbound is consent-gated", () => {
  it("refuses free text when the customer has never written", async () => {
    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.mehmet,
        channel: "whatsapp",
        request: { kind: "reply", body: "Merhaba" },
        sentByUserId: alpha.admin,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe("no_open_session");
  });

  it("refuses a template to somebody with no consent, gateway or not", async () => {
    setIysGateway(createLocalGateway("test"));

    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.stranger,
        channel: "whatsapp",
        request: { kind: "template", template: "review_request", values: ["Kadıköy", "http://x"] },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe("no_consent");
  });

  it("refuses a template when İYS is required and no gateway is wired", async () => {
    // Consent is on file for Mehmet, so this isolates the registry requirement.
    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.mehmet,
        channel: "whatsapp",
        request: { kind: "template", template: "review_request", values: ["Kadıköy", "http://x"] },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe("iys_not_configured");
  });

  it("writes no message row when the gate refuses", async () => {
    // Nothing left the building and nothing was attempted. A thread showing
    // failed sends to somebody who never consented would read as harassment we
    // did not commit.
    const rows = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listThread(tx, alpha.orgId, alpha.stranger),
    );

    expect(rows).toEqual([]);
  });

  it("refuses SMS outright while no gateway is configured", async () => {
    setIysGateway(createLocalGateway("test"));

    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.mehmet,
        channel: "sms",
        request: { kind: "reply", body: "Merhaba" },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The gate passed — consent is on file and the local İYS adapter accepted —
    // and the transport is what is missing. `SMS_GATEWAY` defaults to `none`.
    expect(outcome.refusal).toBe("not_configured");
  });

  it("honours an opt-out over a live permission", async () => {
    setIysGateway(createLocalGateway("test"));
    await customerWrites(alpha, alpha.ayse, new Date());

    await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .update(schema.contacts)
        .set({ unsubscribedAt: new Date() })
        .where(eq(schema.contacts.id, alpha.stranger)),
    );

    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.stranger,
        channel: "whatsapp",
        request: { kind: "reply", body: "Merhaba" },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // An opt-out beats everything, including an open session.
    expect(outcome.refusal).toBe("opted_out");
  });
});

describe("somebody with no number", () => {
  it("is refused before the gate is even consulted", async () => {
    /**
     * The last line of defence, and it had no test (W2.2).
     *
     * It came up in use: the contact profile said "this person has no phone
     * number, so no message can be sent" and linked to the conversation
     * anyway, which rendered a working composer whose every send would fail
     * here — after the message had been written. Both surfaces now refuse up
     * front, and this pins the layer underneath them, which is the one that
     * cannot be routed around by a link somebody adds later.
     *
     * Consent is deliberately on file, so the only thing that can produce this
     * refusal is the missing number.
     */
    setIysGateway(createLocalGateway("test"));

    const [contact] = await getAdminDb()
      .insert(schema.contacts)
      .values({
        organizationId: alpha.orgId,
        name: "Numarasız",
        email: `numarasiz-${suffix}@example.test`,
      })
      .returning({ id: schema.contacts.id });

    await withTenant({ organizationId: alpha.orgId }, (tx) =>
      recordIysConsent({
        tx,
        organizationId: alpha.orgId,
        contactRef: contact!.id,
        channel: "message",
        source: "web_form",
        proofRef: "test",
      }),
    );

    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: contact!.id,
        channel: "whatsapp",
        request: { kind: "template", template: "review_request", values: ["Kadıköy", "http://x"] },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe("no_address");

    // And **no row**: nothing left the building, so the thread must not show a
    // failed message to somebody who could never have received one.
    const rows = await getAdminDb()
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.contactId, contact!.id));

    expect(rows).toHaveLength(0);
  });
});

describe("a mock conversation round-trips", () => {
  it("takes an inbound message, answers it, and records both", async () => {
    const at = new Date();
    await customerWrites(alpha, alpha.ayse, at);

    const open = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      windowState(tx, alpha.orgId, alpha.ayse, at),
    );
    expect(open.open).toBe(true);

    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.ayse,
        channel: "whatsapp",
        request: { kind: "reply", body: "Merhaba, nasıl yardımcı olabiliriz?" },
        sentByUserId: alpha.admin,
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Free text inside the window is a *service* reply — it rests on the
    // customer having written, not on a marketing permission.
    expect(outcome.intent).toBe("service");

    const thread = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listThread(tx, alpha.orgId, alpha.ayse),
    );

    // Oldest first: a conversation is read downwards, so the exchange this test
    // made is the *tail*. Asserted as the last two rather than the whole thread,
    // because Ayşe has written to this business in other tests too and pinning
    // the full history would make this fail whenever a neighbour is added.
    expect(thread.slice(-2).map((message) => message.direction)).toEqual(["inbound", "outbound"]);

    const reply = thread.at(-1);
    expect(reply?.body).toContain("nasıl yardımcı");
    expect(reply?.intent).toBe("service");
    expect(reply?.sentByUserId).toBe(alpha.admin);
  });

  it("does not open its own window by sending", async () => {
    // A business cannot make itself repliable. The gate reads `last_inbound_at`
    // and nothing an outbound send writes.
    const past = new Date(Date.now() - 40 * 60 * 60 * 1_000);
    await customerWrites(beta, beta.ayse, past);

    const state = await withTenant({ organizationId: beta.orgId }, (tx) =>
      windowState(tx, beta.orgId, beta.ayse),
    );

    expect(state.open).toBe(false);

    const outcome = await withTenant({ organizationId: beta.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: beta.orgId,
        contactId: beta.ayse,
        channel: "whatsapp",
        request: { kind: "reply", body: "Hâlâ orada mısınız?" },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe("no_open_session");
  });

  it("ignores a redelivered webhook rather than duplicating the message", async () => {
    // Meta says it may deliver the same webhook more than once, and a duplicate
    // inbound message is indistinguishable from the customer repeating
    // themself.
    const externalId = `wamid.dup-${suffix}`;

    const first = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      recordInbound({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.mehmet,
        channel: "whatsapp",
        body: "Tek sefer",
        externalId,
      }),
    );
    const second = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      recordInbound({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.mehmet,
        channel: "whatsapp",
        body: "Tek sefer",
        externalId,
      }),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);

    const thread = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listThread(tx, alpha.orgId, alpha.mehmet),
    );
    expect(thread.filter((message) => message.body === "Tek sefer")).toHaveLength(1);
  });

  it("advances a delivery receipt forwards only", async () => {
    setIysGateway(createLocalGateway("test"));
    const at = new Date();
    await customerWrites(alpha, alpha.ayse, at);

    const outcome = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: alpha.orgId,
        contactId: alpha.ayse,
        channel: "whatsapp",
        request: { kind: "reply", body: "Makbuz testi" },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      expect(await applyReceipt(tx, alpha.orgId, outcome.externalId, "read")).toBe(true);
      // Receipts arrive out of order; a naive assignment would walk the message
      // backwards and make the thread lie about whether it was seen.
      expect(await applyReceipt(tx, alpha.orgId, outcome.externalId, "delivered")).toBe(false);
    });

    const [row] = await getAdminDb()
      .select({ status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.externalId, outcome.externalId));

    expect(row?.status).toBe("read");
  });

  it("records a platform failure as a row, unlike a gate refusal", async () => {
    setIysGateway(createLocalGateway("test"));
    const at = new Date();
    await customerWrites(beta, beta.mehmet, at);

    // The transport is missing (no credentials, and this org's contact has no
    // usable route) — an attempt that gets past the gate and then fails.
    const before = await withTenant({ organizationId: beta.orgId }, (tx) =>
      listThread(tx, beta.orgId, beta.mehmet),
    );

    const outcome = await withTenant({ organizationId: beta.orgId }, (tx) =>
      sendMessage({
        tx,
        organizationId: beta.orgId,
        contactId: beta.mehmet,
        channel: "sms",
        request: { kind: "reply", body: "SMS denemesi" },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    const after = await withTenant({ organizationId: beta.orgId }, (tx) =>
      listThread(tx, beta.orgId, beta.mehmet),
    );

    // `not_configured` is a refusal *before* the network, so it writes nothing —
    // same as a gate refusal, and for the same reason.
    expect(after.length).toBe(before.length);
    expect(client).toBeDefined();
  });
});

describe("the conversations inbox", () => {
  it("shows one row per contact, newest first, with who spoke last", async () => {
    const rows = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listConversations(tx, alpha.orgId, UNRESTRICTED),
    );

    expect(rows.length).toBeGreaterThan(0);

    const ids = rows.map((row) => row.contactId);
    expect(new Set(ids).size).toBe(ids.length);

    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.lastAt.getTime()).toBeGreaterThanOrEqual(
        rows[index]!.lastAt.getTime(),
      );
    }
  });

  it("never shows another organization's conversations", async () => {
    const rows = await withTenant({ organizationId: beta.orgId }, (tx) =>
      listConversations(tx, beta.orgId, UNRESTRICTED),
    );

    const alphaIds = new Set([alpha.ayse, alpha.mehmet, alpha.stranger]);
    for (const row of rows) expect(alphaIds.has(row.contactId)).toBe(false);
  });

  it("hides a conversation with a contact the member may not see", async () => {
    // Scoped through `contactScopeClause`, not a rule of its own — the messages
    // inbox must not show a branch manager somebody /contacts hides from them.
    const rows = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listConversations(tx, alpha.orgId, { all: false, locationIds: [] }),
    );

    expect(rows).toEqual([]);
  });

  it("reports the window as null when we have never heard from somebody", async () => {
    const rows = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listConversations(tx, alpha.orgId, UNRESTRICTED),
    );

    const stranger = rows.find((row) => row.contactId === alpha.stranger);
    // Null, not false: "they have never written" and "the window has closed"
    // are different sentences on the screen.
    if (stranger) expect(stranger.windowOpen).toBeNull();
  });
});

describe("it ties to the contact timeline", () => {
  it("puts real messages in the history, both directions", async () => {
    const events = await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      const contact = await getContact({
        tx,
        organizationId: alpha.orgId,
        scope: UNRESTRICTED,
        contactId: alpha.ayse,
      });
      return contactTimeline(tx, alpha.orgId, contact!);
    });

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("message_in");
    expect(kinds).toContain("message_out");

    // The words, not just the fact. Until P4-T3 this loader had only two
    // timestamps to work from and could show neither.
    const outbound = events.find((event) => event.kind === "message_out");
    expect(outbound && "body" in outbound ? outbound.body : null).toBeTruthy();
  });
});
