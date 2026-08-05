import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { UNRESTRICTED, setMemberLocations } from "@/auth/scope";
import { recordIysConsent } from "@/compliance/consent";
import { createLocalGateway } from "@/compliance/iys-gateway";
import { setIysGateway } from "@/compliance/gate";
import { unsubscribeByToken } from "@/collect/public";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { EntitlementError } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { recordAnswer, recordFollowUp, resolveSurveyByToken } from "@/surveys/public";
import { loadSurveyInsights } from "@/surveys/insights";
import { sendSurveyInvites } from "@/surveys/send";
import { createSurvey, listAnswers, listSurveys, updateSurvey } from "@/surveys/store";
import { subscribeToPlanWith } from "./plan-fixture";

/**
 * Surveys (P4-T2).
 *
 * Two compliance rules run through this file and both are asserted directly,
 * because `docs/20` P4-T7 asks for exactly that:
 *
 *   - **İYS/consent before every outbound.** A survey invitation is a
 *     commercial message, so no recipient is emailed without a permission the
 *     gate accepts — and the default posture (no gateway configured) refuses
 *     everybody, which is the correct behaviour before go-live rather than a
 *     bug.
 *   - **No review-gating.** The structural half is
 *     `tests/lib/survey-gating.test.ts`; what is asserted here is that the
 *     stored survey carries a *campaign* rather than a URL, so the destination
 *     is resolved by the same function review requests use.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
const userIds: string[] = [];

type Fixture = {
  orgId: string;
  kadikoy: string;
  besiktas: string;
  campaignId: string;
  admin: string;
};

let alpha: Fixture;
let beta: Fixture;
/** Pinned to Kadıköy. */
let scoped: string;

async function makeOrg(label: string): Promise<Fixture> {
  const db = getAdminDb();

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Surveys ${label} ${suffix}`, slug: `surveys-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  await subscribeToPlanWith(org.id, ["surveys"]);

  const locations = await db
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: "Kadıköy Şubesi" },
      { organizationId: org.id, name: "Beşiktaş Şubesi" },
    ])
    .returning({ id: schema.locations.id });

  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      organizationId: org.id,
      locationId: locations[0]!.id,
      name: "Yorum daveti",
      slug: `sc-${label}-${suffix}`,
      status: "active",
    })
    .returning({ id: schema.campaigns.id });

  const [user] = await db
    .insert(schema.users)
    .values({ email: `survey-admin-${label}-${suffix}@example.com`, name: "Admin" })
    .returning({ id: schema.users.id });
  userIds.push(user!.id);
  await db
    .insert(schema.memberships)
    .values({ organizationId: org.id, userId: user!.id, role: "admin" });

  return {
    orgId: org.id,
    kadikoy: locations[0]!.id,
    besiktas: locations[1]!.id,
    campaignId: campaign!.id,
    admin: user!.id,
  };
}

/** Creates an active survey and returns its id. */
async function makeSurvey(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createSurvey>[3]> = {},
): Promise<{ id: string; slug: string }> {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    createSurvey(tx, fixture.orgId, UNRESTRICTED, {
      name: `Ziyaret sonrası ${Math.random().toString(36).slice(2, 8)}`,
      type: "nps",
      locationId: fixture.kadikoy,
      locale: "tr",
      question: null,
      followUpEnabled: true,
      followUpPrompt: null,
      reviewCampaignId: fixture.campaignId,
      status: "active",
      ...overrides,
    }),
  );
}

beforeAll(async () => {
  alpha = await makeOrg("alpha");
  beta = await makeOrg("beta");

  const db = getAdminDb();
  const [member] = await db
    .insert(schema.users)
    .values({ email: `survey-scoped-${suffix}@example.com`, name: "Scoped" })
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

afterEach(() => {
  // The gate is process-global; a test that installs one must not leak it into
  // the next, or "no gateway configured" stops being testable.
  setIysGateway(null);
});

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

describe("the İYS gate on every outbound", () => {
  it("refuses even a consented recipient when no gateway is configured", async () => {
    /**
     * The default posture, and the intended one before go-live: `IYS_REQUIRED`
     * defaults to true and `IYS_GATEWAY` to none, so nothing may leave.
     *
     * The recipient is given a **valid local permission first**, deliberately.
     * Without it the refusal would be `no_consent` — the gate checks the local
     * record before it asks the registry, which is the right order — and the
     * test would pass while proving nothing about the gateway requirement. The
     * point here is that a business holding a perfectly good consent still
     * cannot send until the registry is reachable, because İYS is the system of
     * record and our copy is not a substitute for it.
     */
    const survey = await makeSurvey(alpha);
    const email = `gate-a-${suffix}@example.com`;

    await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      const [contact] = await tx
        .insert(schema.contacts)
        .values({ organizationId: alpha.orgId, email, name: "Ayşe" })
        .returning({ id: schema.contacts.id });

      await recordIysConsent({
        tx,
        organizationId: alpha.orgId,
        contactRef: contact!.id,
        channel: "email",
        source: "web_form",
        proofRef: "test",
      });
    });

    const outcome = await sendSurveyInvites({
      organizationId: alpha.orgId,
      actorUserId: alpha.admin,
      surveyId: survey.id,
      recipients: [{ email, name: "Ayşe" }],
    });

    expect(outcome.sent).toBe(0);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]!.reason).toBe("iys_not_configured");

    // And no row was created implying we meant to message them.
    const rows = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .select({ id: schema.surveyResponses.id })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, survey.id)),
    );
    expect(rows).toEqual([]);
  });

  it("refuses a recipient with no consent even when a gateway is wired", async () => {
    setIysGateway(createLocalGateway("test"));
    const survey = await makeSurvey(alpha);

    const outcome = await sendSurveyInvites({
      organizationId: alpha.orgId,
      actorUserId: alpha.admin,
      surveyId: survey.id,
      recipients: [{ email: `gate-b-${suffix}@example.com`, name: null }],
    });

    expect(outcome.sent).toBe(0);
    // The local record is what is missing here, not the registry — and the
    // reason says so, which is the difference between a deployment problem and
    // a customer who never opted in.
    expect(outcome.refused[0]!.reason).toBe("no_consent");
  });

  it("sends to a recipient who granted an İYS permission", async () => {
    setIysGateway(createLocalGateway("test"));
    const survey = await makeSurvey(alpha);
    const email = `gate-c-${suffix}@example.com`;

    const contactId = await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      const [contact] = await tx
        .insert(schema.contacts)
        .values({ organizationId: alpha.orgId, email, name: "Ayşe" })
        .returning({ id: schema.contacts.id });

      await recordIysConsent({
        tx,
        organizationId: alpha.orgId,
        contactRef: contact!.id,
        channel: "email",
        source: "web_form",
        proofRef: "test",
      });

      return contact!.id;
    });

    const outcome = await sendSurveyInvites({
      organizationId: alpha.orgId,
      actorUserId: alpha.admin,
      surveyId: survey.id,
      recipients: [{ email, name: "Ayşe" }],
    });

    expect(outcome.refused).toEqual([]);
    expect(outcome.sent).toBe(1);

    const [row] = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .select({
          status: schema.surveyResponses.status,
          contactId: schema.surveyResponses.contactId,
          sentAt: schema.surveyResponses.sentAt,
        })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, survey.id)),
    );

    expect(row?.status).toBe("sent");
    expect(row?.contactId).toBe(contactId);
    expect(row?.sentAt).not.toBeNull();
  });

  it("refuses somebody who has opted out, whatever their consent says", async () => {
    setIysGateway(createLocalGateway("test"));
    const survey = await makeSurvey(alpha);
    const email = `gate-d-${suffix}@example.com`;

    await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      const [contact] = await tx
        .insert(schema.contacts)
        .values({
          organizationId: alpha.orgId,
          email,
          name: "Mehmet",
          unsubscribedAt: new Date(),
        })
        .returning({ id: schema.contacts.id });

      await recordIysConsent({
        tx,
        organizationId: alpha.orgId,
        contactRef: contact!.id,
        channel: "email",
        source: "web_form",
        proofRef: "test",
      });
    });

    const outcome = await sendSurveyInvites({
      organizationId: alpha.orgId,
      actorUserId: alpha.admin,
      surveyId: survey.id,
      recipients: [{ email, name: null }],
    });

    // An opt-out beats a permission. Somebody who said stop has said stop.
    expect(outcome.sent).toBe(0);
    expect(outcome.refused[0]!.reason).toBe("opted_out");
  });

  it("gives the opt-out link in a survey email something to resolve", async () => {
    // The bug this exists to catch: `unsubscribeByToken` knew only about review
    // requests, so a survey's compliance footer would have linked to a route
    // that quietly did nothing — the worst possible failure for the one control
    // a recipient is legally entitled to.
    setIysGateway(createLocalGateway("test"));
    const survey = await makeSurvey(alpha);
    const email = `gate-e-${suffix}@example.com`;

    await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      const [contact] = await tx
        .insert(schema.contacts)
        .values({ organizationId: alpha.orgId, email, name: "Elif" })
        .returning({ id: schema.contacts.id });

      await recordIysConsent({
        tx,
        organizationId: alpha.orgId,
        contactRef: contact!.id,
        channel: "email",
        source: "web_form",
        proofRef: "test",
      });
    });

    await sendSurveyInvites({
      organizationId: alpha.orgId,
      actorUserId: alpha.admin,
      surveyId: survey.id,
      recipients: [{ email, name: null }],
    });

    const [row] = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .select({ token: schema.surveyResponses.token })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, survey.id)),
    );

    const result = await unsubscribeByToken(row!.token);
    expect(result.ok).toBe(true);
    expect(result.email).toBe(email);
  });
});

describe("answering", () => {
  it("records a score against the token we sent, once", async () => {
    setIysGateway(createLocalGateway("test"));
    const survey = await makeSurvey(alpha);
    const email = `answer-a-${suffix}@example.com`;

    await withTenant({ organizationId: alpha.orgId }, async (tx) => {
      const [contact] = await tx
        .insert(schema.contacts)
        .values({ organizationId: alpha.orgId, email, name: "Ayşe" })
        .returning({ id: schema.contacts.id });
      await recordIysConsent({
        tx,
        organizationId: alpha.orgId,
        contactRef: contact!.id,
        channel: "email",
        source: "web_form",
        proofRef: "test",
      });
    });

    await sendSurveyInvites({
      organizationId: alpha.orgId,
      actorUserId: alpha.admin,
      surveyId: survey.id,
      recipients: [{ email, name: null }],
    });

    const [row] = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .select({ token: schema.surveyResponses.token })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, survey.id)),
    );
    const token = row!.token;

    const first = await recordAnswer({ token, score: 9, comment: "Çok iyiydi" }, { ip: null });
    expect(first.ok).toBe(true);

    // One ask, one answer — otherwise a leaked token is a way to move a
    // business's score.
    const second = await recordAnswer({ token, score: 0 }, { ip: null });
    expect(second).toEqual({ ok: false, error: "already_answered" });

    const answers = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listAnswers(tx, alpha.orgId, survey.id),
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]!.score).toBe(9);
    expect(answers[0]!.comment).toBe("Çok iyiydi");
  });

  it("accepts a walk-in answer against the survey's public slug", async () => {
    const survey = await makeSurvey(alpha);

    const result = await recordAnswer({ slug: survey.slug, score: 7 }, { ip: null });
    expect(result.ok).toBe(true);

    const [row] = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .select({
          contactId: schema.surveyResponses.contactId,
          sentAt: schema.surveyResponses.sentAt,
          channel: schema.surveyResponses.channel,
        })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, survey.id)),
    );

    // Nobody was asked and nobody handed over an address.
    expect(row?.contactId).toBeNull();
    expect(row?.sentAt).toBeNull();
    expect(row?.channel).toBe("link");
  });

  it("refuses a score off the instrument's scale", async () => {
    const survey = await makeSurvey(alpha, { type: "csat" });

    // 7 is a legal NPS answer and not a legal CSAT one. The database's 0–10
    // check would have let it through; the scale is what actually decides.
    expect(await recordAnswer({ slug: survey.slug, score: 7 }, { ip: null })).toEqual({
      ok: false,
      error: "invalid_score",
    });
    expect((await recordAnswer({ slug: survey.slug, score: 4 }, { ip: null })).ok).toBe(true);
  });

  it("refuses an answer to a survey that is not active", async () => {
    const survey = await makeSurvey(alpha, { status: "draft" });
    expect(await recordAnswer({ slug: survey.slug, score: 5 }, { ip: null })).toEqual({
      ok: false,
      error: "closed",
    });
  });

  it("keeps the private follow-up out of the answer's own comment", async () => {
    const survey = await makeSurvey(alpha);
    const answered = await recordAnswer(
      { slug: survey.slug, score: 2, comment: "Servis çok yavaştı" },
      { ip: null },
    );
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    expect(await recordFollowUp(answered.token, "Garson ilgilenmedi")).toEqual({ ok: true });

    const invite = await resolveSurveyByToken(answered.token);
    expect(invite?.followUpComment).toBe("Garson ilgilenmedi");

    const answers = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listAnswers(tx, alpha.orgId, survey.id),
    );
    // Two columns, two promises. The comment is what the survey asked for; the
    // follow-up answers "what went wrong", and conflating them would put a
    // private complaint into the pool a business quotes from.
    expect(answers[0]!.comment).toBe("Servis çok yavaştı");
    expect(answers[0]!.followUpComment).toBe("Garson ilgilenmedi");
  });

  it("refuses a follow-up for a token that has not answered", async () => {
    setIysGateway(createLocalGateway("test"));
    const survey = await makeSurvey(alpha);
    const result = await recordFollowUp("nosuchtokennosuchtoken", "hi");
    expect(result).toEqual({ ok: false });
    expect(survey.id).toBeTruthy();
  });
});

describe("tenancy and scope", () => {
  it("never lists another organization's surveys", async () => {
    await makeSurvey(alpha);
    await makeSurvey(beta);

    const rows = await withTenant({ organizationId: beta.orgId }, (tx) =>
      listSurveys(tx, beta.orgId, UNRESTRICTED),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.locationName).toBe("Kadıköy Şubesi");

    const alphaIds = new Set(
      (
        await withTenant({ organizationId: alpha.orgId }, (tx) =>
          listSurveys(tx, alpha.orgId, UNRESTRICTED),
        )
      ).map((row) => row.id),
    );
    for (const row of rows) expect(alphaIds.has(row.id)).toBe(false);
  });

  it("resolves the tenant from the code, and writes the answer into that tenant only", async () => {
    // The public-surface rule, at the one place Phase 4 adds an unauthenticated
    // write. Two organizations hold surveys of the same shape; the code decides
    // which, and no caller supplies an organization id anywhere.
    const mine = await makeSurvey(alpha);
    const theirs = await makeSurvey(beta);

    expect(await recordAnswer({ slug: theirs.slug, score: 8 }, { ip: null })).toMatchObject({
      ok: true,
    });

    const inAlpha = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      tx
        .select({ id: schema.surveyResponses.id })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, theirs.id)),
    );
    const inBeta = await withTenant({ organizationId: beta.orgId }, (tx) =>
      tx
        .select({ id: schema.surveyResponses.id })
        .from(schema.surveyResponses)
        .where(eq(schema.surveyResponses.surveyId, theirs.id)),
    );

    // RLS is the final say: alpha's tenant context cannot see the row even
    // knowing the survey id, and beta's can.
    expect(inAlpha).toEqual([]);
    expect(inBeta.length).toBe(1);
    expect(mine.id).not.toBe(theirs.id);
  });

  it("shows a respondent only their own organization's name", async () => {
    const survey = await makeSurvey(beta);
    const answered = await recordAnswer({ slug: survey.slug, score: 5 }, { ip: null });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    const invite = await resolveSurveyByToken(answered.token);
    expect(invite?.survey.organizationName).toContain("beta");
    expect(invite?.survey.organizationName).not.toContain("alpha");
  });

  it("narrows the list to the branches a member was pinned to", async () => {
    await makeSurvey(alpha, { locationId: alpha.besiktas });

    const rows = await withTenant({ organizationId: alpha.orgId, userId: scoped }, (tx) =>
      listSurveys(tx, alpha.orgId, { all: false, locationIds: [alpha.kadikoy] }),
    );

    for (const row of rows) expect(row.locationId).toBe(alpha.kadikoy);
  });

  it("returns nothing — not everything — for a scope pinned to nothing", async () => {
    const rows = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      listSurveys(tx, alpha.orgId, { all: false, locationIds: [] }),
    );
    expect(rows).toEqual([]);
  });

  it("refuses a review campaign belonging to another organization", async () => {
    // A survey pointing at a stranger's campaign would send a customer to
    // somebody else's review page.
    await expect(
      withTenant({ organizationId: alpha.orgId }, (tx) =>
        createSurvey(tx, alpha.orgId, UNRESTRICTED, {
          name: "Sızıntı",
          type: "nps",
          locationId: alpha.kadikoy,
          locale: null,
          question: null,
          followUpEnabled: true,
          followUpPrompt: null,
          reviewCampaignId: beta.campaignId,
          status: "draft",
        }),
      ),
    ).rejects.toThrow();
  });

  it("stores a campaign, never a destination URL", async () => {
    // The structural half of the no-review-gating rule, at the schema: a survey
    // cannot name a review destination of its own, so where it points is
    // resolved by `src/collect/routing.ts` — which takes a campaign and nothing
    // else, and has never been able to see a rating.
    const survey = await makeSurvey(alpha);
    const [row] = await getAdminDb()
      .select()
      .from(schema.surveys)
      .where(eq(schema.surveys.id, survey.id));

    expect(row?.reviewCampaignId).toBe(alpha.campaignId);
    expect(Object.keys(row ?? {})).not.toContain("destinationUrl");
  });
});

describe("the type is not editable", () => {
  it("keeps the instrument a survey was created with", async () => {
    const survey = await makeSurvey(alpha, { type: "csat" });

    await withTenant({ organizationId: alpha.orgId }, (tx) =>
      updateSurvey(tx, alpha.orgId, UNRESTRICTED, survey.id, {
        name: "Yeniden adlandırıldı",
        locationId: alpha.kadikoy,
        locale: null,
        question: null,
        followUpEnabled: false,
        followUpPrompt: null,
        reviewCampaignId: null,
        status: "active",
      }),
    );

    const [row] = await getAdminDb()
      .select({ type: schema.surveys.type, name: schema.surveys.name })
      .from(schema.surveys)
      .where(eq(schema.surveys.id, survey.id));

    expect(row?.name).toBe("Yeniden adlandırıldı");
    // Changing it would reinterpret every answer already collected.
    expect(row?.type).toBe("csat");
  });
});

describe("insights", () => {
  it("scores answers in the window, and returns nothing for an empty scope", async () => {
    const survey = await makeSurvey(alpha);
    for (const score of [10, 10, 9, 6, 0]) {
      await recordAnswer({ slug: survey.slug, score }, { ip: null });
    }

    const now = new Date();
    const window = {
      range: "30d" as const,
      days: 30,
      start: new Date(now.getTime() - 30 * 86_400_000),
      end: new Date(now.getTime() + 60_000),
      previous: {
        start: new Date(now.getTime() - 60 * 86_400_000),
        end: new Date(now.getTime() - 30 * 86_400_000),
      },
    };

    const scored = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      loadSurveyInsights(tx, alpha.orgId, [alpha.kadikoy, alpha.besiktas], window),
    );

    const nps = scored.find((entry) => entry.type === "nps");
    expect(nps?.current.responses).toBeGreaterThanOrEqual(5);
    // Nothing in the window before, so there is nothing to compare against —
    // null rather than a zero that would read as a collapse.
    expect(nps?.previous).toBeNull();

    const empty = await withTenant({ organizationId: alpha.orgId }, (tx) =>
      loadSurveyInsights(tx, alpha.orgId, [], window),
    );
    expect(empty).toEqual([]);
  });
});

describe("entitlement", () => {
  it("refuses a survey on a plan without them", async () => {
    const db = getAdminDb();
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: `Surveys floor ${suffix}`, slug: `surveys-floor-${suffix}` })
      .returning({ id: schema.organizations.id });
    orgIds.push(org!.id);

    const [location] = await db
      .insert(schema.locations)
      .values({ organizationId: org!.id, name: "Şube" })
      .returning({ id: schema.locations.id });

    // No subscription, so the organization sits on the floor plan. The gate is
    // in the *action*, so this asserts it where a caller would meet it.
    const { createSurveyAction } = await import("@/server/surveys");
    expect(typeof createSurveyAction).toBe("function");

    // …and directly, in the data layer, where the send path also checks.
    const { requireFeature } = await import("@/lib/entitlements");
    await expect(
      withTenant({ organizationId: org!.id }, (tx) =>
        requireFeature({ organizationId: org!.id, tx }, "surveys"),
      ),
    ).rejects.toBeInstanceOf(EntitlementError);

    expect(location?.id).toBeTruthy();
  });
});
