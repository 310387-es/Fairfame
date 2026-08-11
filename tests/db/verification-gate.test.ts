import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  requireVerifiedSender,
  senderVerification,
  UnverifiedSenderError,
} from "@/auth/verification";
import { runBroadcast } from "@/broadcasts/pipeline";
import { EMPTY_CONTACT_FILTERS, contactFiltersToRecord } from "@/contacts/filters";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { toActionResult } from "@/server/action-result";
import { UNVERIFIED_EMAIL } from "@/lib/validation-keys";
import { withTenant } from "@/lib/tenancy";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * An unverified sender cannot make the product write to a stranger (P5-T4).
 *
 * The **behaviour**; `tests/lib/verification-gate.test.ts` holds the
 * completeness half — which paths must ask at all. Both are needed and neither
 * substitutes for the other: this file proves the door is locked, and that one
 * notices a new door.
 *
 * The interesting case is the last one. `sendBroadcastAction` refuses the
 * person at the button, which is easy to get right and easy to test through the
 * action. The path that actually needed thinking about is the **scheduled**
 * send, where there is no session, no actor and nobody watching — a broadcast
 * queued by an unverified account and fired days later by the sweep. That is
 * the one asserted end-to-end here, because it is the one a UI check cannot
 * cover and the one CLAUDE.md's "ask the entitlement twice" rule exists for.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

async function makeUser(label: string, emailVerified: boolean): Promise<string> {
  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({
      email: `vg-${label}-${suffix}@example.com`,
      name: label,
      emailVerified,
    })
    .returning({ id: schema.users.id });

  userIds.push(user!.id);
  return user!.id;
}

afterAll(async () => {
  const db = getAdminDb();
  for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id));
  for (const id of orgIds)
    await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  await closeDatabasePools();
});

describe("the rule itself", () => {
  it("reads the live column rather than anything cached", async () => {
    const id = await makeUser("live", false);
    expect((await senderVerification(id)).verified).toBe(false);

    await getAdminDb()
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, id));

    // Somebody who verifies in a second tab must be able to press the button
    // again immediately. A value taken from the session cookie would say no for
    // another thirty days.
    expect((await senderVerification(id)).verified).toBe(true);
  });

  it("refuses with the address that needs confirming, so the UI can name it", async () => {
    const id = await makeUser("refused", false);

    await expect(requireVerifiedSender(id)).rejects.toThrow(UnverifiedSenderError);
    await expect(requireVerifiedSender(id)).rejects.toMatchObject({
      email: `vg-refused-${suffix}@example.com`,
    });
  });

  it("lets a verified sender through", async () => {
    const id = await makeUser("allowed", true);
    await expect(requireVerifiedSender(id)).resolves.toBeUndefined();
  });

  it("treats an unknown user as unverified rather than throwing", async () => {
    // Unreachable from a live session. If it happens anyway, the safe answer to
    // "may this unknown account mail strangers" is no — not a stack trace, and
    // certainly not yes.
    const { verified } = await senderVerification(crypto.randomUUID());
    expect(verified).toBe(false);
  });

  it("reaches the caller as a code an action can key a button off", () => {
    // The refusal has a *way out* attached — "send the email again" — and a
    // bare sentence gives the client nothing to hang that on.
    const result = toActionResult(new UnverifiedSenderError("someone@example.com"));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(UNVERIFIED_EMAIL);
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("the scheduled path, where the session is long gone", () => {
  it("abandons a broadcast whose author never confirmed their address", async () => {
    const db = getAdminDb();

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: `Verify ${suffix}`, slug: `verify-${suffix}`, locale: "tr" })
      .returning({ id: schema.organizations.id });
    orgIds.push(org!.id);
    // The plan is asked for by *feature*, never named — the broadcast has to
    // clear the entitlement check that sits immediately above the verification
    // one, or this test would pass for the wrong reason.
    await subscribeToPlanWith(org!.id, ["broadcasts"]);

    const author = await makeUser("author", false);
    await db
      .insert(schema.memberships)
      .values({ organizationId: org!.id, userId: author, role: "admin" });

    const [contact] = await db
      .insert(schema.contacts)
      .values({
        organizationId: org!.id,
        name: "Ayşe",
        email: `vg-contact-${suffix}@example.com`,
      })
      .returning({ id: schema.contacts.id });

    const [segment] = await db
      .insert(schema.contactSegments)
      .values({
        organizationId: org!.id,
        name: "Everyone",
        filters: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
      })
      .returning({ id: schema.contactSegments.id });

    const [location] = await db
      .insert(schema.locations)
      .values({ organizationId: org!.id, name: "Kadıköy Şubesi" })
      .returning({ id: schema.locations.id });

    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        organizationId: org!.id,
        locationId: location!.id,
        name: "Yorum daveti",
        slug: `vg-${suffix}`,
        status: "active",
      })
      .returning({ id: schema.campaigns.id });

    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({
        organizationId: org!.id,
        name: "Scheduled by an unverified account",
        // A review request rather than a free message: it is the kind with the
        // fewest schema preconditions, and the kind an abusive signup would
        // actually reach for.
        kind: "review_request",
        channel: "email",
        status: "scheduled",
        segmentId: segment!.id,
        audience: contactFiltersToRecord(EMPTY_CONTACT_FILTERS),
        campaignId: campaign!.id,
        createdByUserId: author,
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: schema.broadcasts.id });

    const outcome = await runBroadcast(org!.id, broadcast!.id);

    // Nothing went out, and the row says why rather than sitting in `sending`
    // forever — a throw here would be a worker stack trace nobody reads.
    expect(outcome.sent).toBe(0);
    expect(outcome.abandoned).toMatch(/confirm/i);

    const [row] = await withTenant({ organizationId: org!.id }, (tx) =>
      tx
        .select({ status: schema.broadcasts.status, reason: schema.broadcasts.failureReason })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, broadcast!.id)),
    );

    expect(row?.status).toBe("cancelled");
    expect(row?.reason).toMatch(/confirm/i);

    // And the contact was never written to. The point of refusing before the
    // send loop is that no half-run is left behind.
    const messages = await withTenant({ organizationId: org!.id }, (tx) =>
      tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.contactId, contact!.id)),
    );
    expect(messages).toEqual([]);
  });
});
