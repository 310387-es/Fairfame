import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Role } from "@/auth/permissions";
import { resolveLocationScope } from "@/auth/scope";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import {
  bulkAssign,
  bulkDraftFromTemplate,
  bulkSetStatus,
  bulkDraftWithAi,
  bulkTag,
  bulkUntag,
  MAX_BULK_ITEMS,
  MAX_BULK_AI_DRAFTS,
} from "@/reviews/bulk";
import { listInbox } from "@/reviews/queries";
import { TriageError, type TriageActor } from "@/reviews/triage";
import { withTenant } from "@/lib/tenancy";
import { subscribeToPlanWith } from "./plan-fixture";
import { saveReplyTemplate } from "@/replies/templates";

/**
 * Bulk actions (P2-T6).
 *
 * The Definition of Done: "bulk assign/status/tag work on a selection; bulk
 * public-reply requires review; authz holds." The middle clause is the one worth
 * writing tests for twice — it is the guardrail the build plan singles out, and
 * the failure mode is not an error message but forty identical replies on a
 * public platform under the business's name.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Person = { userId: string; membershipId: string; role: Role };

type Fixture = {
  orgId: string;
  kadikoy: string;
  besiktas: string;
  admin: Person;
  /** Scoped to Kadıköy only. */
  scopedMember: Person;
  client: Person;
};

async function addPerson(orgId: string, label: string, role: Role): Promise<Person> {
  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `${label}-${suffix}-${counter++}@example.com`, name: label })
    .returning({ id: schema.users.id });

  const [membership] = await getAdminDb()
    .insert(schema.memberships)
    .values({ organizationId: orgId, userId: user!.id, role })
    .returning({ id: schema.memberships.id });

  return { userId: user!.id, membershipId: membership!.id, role };
}

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Bulk ${label}`, slug: `bulk-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  // The floor plan excludes team-workflow features (P2-T8).
  await subscribeToPlanWith(org.id, ["bulk_actions"]);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: "Kadıköy" },
      { organizationId: org.id, name: "Beşiktaş" },
    ])
    .returning({ id: schema.locations.id });

  const fixture: Fixture = {
    orgId: org.id,
    kadikoy: locations[0]!.id,
    besiktas: locations[1]!.id,
    admin: await addPerson(org.id, "Admin", "admin"),
    scopedMember: await addPerson(org.id, "Scoped", "member"),
    client: await addPerson(org.id, "Client", "client"),
  };

  await getAdminDb().insert(schema.memberLocations).values({
    organizationId: org.id,
    membershipId: fixture.scopedMember.membershipId,
    locationId: fixture.kadikoy,
  });

  return fixture;
}

async function addReview(fixture: Fixture, locationId?: string): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: locationId ?? fixture.kadikoy,
      source: "mock",
      sourceReviewId: `b-${suffix}-${counter++}`,
      authorName: "Selin",
      rating: 2,
      text: "Servis yavaştı.",
      postedAt: new Date(),
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

async function actorFor(
  fixture: Fixture,
  person: Person,
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
): Promise<TriageActor> {
  return {
    organizationId: fixture.orgId,
    userId: person.userId,
    role: person.role,
    scope: await resolveLocationScope(tx, fixture.orgId, person.userId, person.role),
  };
}

async function readReviews(ids: string[]) {
  return getAdminDb().select().from(schema.reviews).where(inArray(schema.reviews.id, ids));
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("bulk status and assignment", () => {
  let fixture: Fixture;
  let ids: string[];

  beforeEach(async () => {
    fixture = await makeFixture(`status-${counter++}`);
    ids = [await addReview(fixture), await addReview(fixture), await addReview(fixture)];
  });

  it("moves a whole selection", async () => {
    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        status: "done",
      }),
    );

    expect(outcome.changed).toHaveLength(3);
    expect((await readReviews(ids)).every((row) => row.status === "done")).toBe(true);
  });

  it("counts only what actually changed", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: [ids[0]!],
        status: "done",
      }),
    );

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        status: "done",
      }),
    );

    // A bar that says "3 updated" after changing two is a bar nobody trusts.
    expect(outcome.changed).toHaveLength(2);
  });

  it("writes one audit row per review, marked as bulk", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        status: "ignored",
      }),
    );

    const rows = await getAdminDb()
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.organizationId, fixture.orgId),
          eq(schema.auditLogs.action, "review.status_changed"),
        ),
      );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.entity)).size).toBe(3);
    expect(rows[0]?.meta).toMatchObject({ bulk: true, batchSize: 3, to: "ignored" });
  });

  it("assigns a whole selection", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkAssign(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        assigneeUserId: fixture.scopedMember.userId,
      }),
    );

    expect(
      (await readReviews(ids)).every((row) => row.assigneeUserId === fixture.scopedMember.userId),
    ).toBe(true);
  });
});

describe("authorization holds per item", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`authz-${counter++}`);
  });

  it("skips the reviews a scoped member cannot see, and changes the rest", async () => {
    const mine = await addReview(fixture, fixture.kadikoy);
    const theirs = await addReview(fixture, fixture.besiktas);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.scopedMember, tx), {
        reviewIds: [mine, theirs],
        status: "done",
      }),
    );

    expect(outcome.changed).toEqual([mine]);
    expect(outcome.skipped).toEqual([{ id: theirs, reason: "out_of_scope" }]);

    const rows = await readReviews([mine, theirs]);
    expect(rows.find((row) => row.id === theirs)?.status).toBe("open");
  });

  it("reports an id from another organization as not found", async () => {
    // Not "out of scope", and not an error naming the other tenant: telling a
    // caller that an id exists somewhere else is itself a leak.
    const neighbour = await makeFixture(`authz-other-${counter++}`);
    const theirs = await addReview(neighbour);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: [theirs],
        status: "done",
      }),
    );

    expect(outcome.changed).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: theirs, reason: "not_found" }]);
  });

  it("refuses a client outright", async () => {
    const id = await addReview(fixture);

    await expect(
      withTenant({ organizationId: fixture.orgId }, async (tx) =>
        bulkSetStatus(tx, await actorFor(fixture, fixture.client, tx), {
          reviewIds: [id],
          status: "done",
        }),
      ),
    ).rejects.toThrow(TriageError);
  });

  it("will not assign work to someone who cannot reach the location", async () => {
    const elsewhere = await addReview(fixture, fixture.besiktas);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkAssign(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: [elsewhere],
        assigneeUserId: fixture.scopedMember.userId,
      }),
    );

    expect(outcome.changed).toEqual([]);
    expect(outcome.skipped[0]?.reason).toBe("out_of_scope");
  });

  it("never touches more than the cap, however many are sent", async () => {
    const many = Array.from({ length: MAX_BULK_ITEMS + 5 }, (_, index) => index);
    const created: string[] = [];
    for (const _ of many.slice(0, 3)) created.push(await addReview(fixture));

    // Real ids plus a long tail of ids that do not exist: the cap must apply to
    // what is *considered*, not only to what is found.
    const padded = [
      ...created,
      ...Array.from({ length: MAX_BULK_ITEMS + 5 }, () => crypto.randomUUID()),
    ];

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkSetStatus(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: padded,
        status: "done",
      }),
    );

    expect(outcome.changed.length + outcome.skipped.length).toBeLessThanOrEqual(MAX_BULK_ITEMS);
  });
});

describe("bulk tagging", () => {
  let fixture: Fixture;
  let ids: string[];

  beforeEach(async () => {
    fixture = await makeFixture(`tag-${counter++}`);
    ids = [await addReview(fixture), await addReview(fixture)];
  });

  it("tags a selection and makes it filterable", async () => {
    const found = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await bulkTag(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        slug: "iade",
      });

      return listInbox(tx, fixture.orgId, fixture.kadikoy, { theme: "iade" });
    });

    // A tag nobody can filter by is a tag that does nothing.
    expect(found.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
  });

  it("does not touch what the model said", async () => {
    // `review_insights.topics` is evidence. A human tag lives beside it, never
    // inside it, or a re-analysis would silently erase the human's work.
    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: ids[0]!,
        sentiment: "negative",
        sentimentScore: -0.5,
        topics: ["servis"],
        promptId: "test",
        model: "test",
      });

    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkTag(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: [ids[0]!],
        slug: "iade",
      }),
    );

    const [insight] = await getAdminDb()
      .select()
      .from(schema.reviewInsights)
      .where(eq(schema.reviewInsights.reviewId, ids[0]!));

    expect(insight?.topics).toEqual(["servis"]);
  });

  it("reuses the vocabulary rather than inventing a second spelling", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = await actorFor(fixture, fixture.admin, tx);
      await bulkTag(tx, actor, { reviewIds: [ids[0]!], slug: "iade" });
      await bulkTag(tx, actor, { reviewIds: [ids[1]!], slug: "  IADE  " });
    });

    const tags = await getAdminDb()
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.organizationId, fixture.orgId));

    expect(tags).toHaveLength(1);
  });

  it("takes a tag back off, so a mistake on forty reviews is recoverable", async () => {
    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = await actorFor(fixture, fixture.admin, tx);
      await bulkTag(tx, actor, { reviewIds: ids, slug: "iade" });
      return bulkUntag(tx, actor, { reviewIds: ids, slug: "iade" });
    });

    expect(outcome.changed.sort()).toEqual([...ids].sort());

    const remaining = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listInbox(tx, fixture.orgId, fixture.kadikoy, { theme: "iade" }),
    );
    expect(remaining.rows).toEqual([]);
  });

  it("removes the tag from only the selection", async () => {
    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = await actorFor(fixture, fixture.admin, tx);
      await bulkTag(tx, actor, { reviewIds: ids, slug: "iade" });
      return bulkUntag(tx, actor, { reviewIds: [ids[0]!], slug: "iade" });
    });

    expect(outcome.changed).toEqual([ids[0]!]);

    const left = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listInbox(tx, fixture.orgId, fixture.kadikoy, { theme: "iade" }),
    );
    expect(left.rows.map((row) => row.id)).toEqual([ids[1]!]);
  });

  it("keeps the vocabulary entry after the last review loses it", async () => {
    // An owner who clears a theme this week and re-applies it next week should
    // find their own spelling waiting, not have to invent it again.
    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = await actorFor(fixture, fixture.admin, tx);
      await bulkTag(tx, actor, { reviewIds: ids, slug: "iade" });
      await bulkUntag(tx, actor, { reviewIds: ids, slug: "iade" });
    });

    const tags = await getAdminDb()
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.organizationId, fixture.orgId));

    expect(tags.map((tag) => tag.slug)).toEqual(["iade"]);
  });

  it("says nothing changed when the tag was never applied", async () => {
    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkUntag(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        slug: "hicbiryerde",
      }),
    );

    expect(outcome.changed).toEqual([]);
  });

  it("will not untag a review outside the actor's scope", async () => {
    const elsewhere = await addReview(fixture, fixture.besiktas);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await bulkTag(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: [elsewhere],
        slug: "iade",
      });
      return bulkUntag(tx, await actorFor(fixture, fixture.scopedMember, tx), {
        reviewIds: [elsewhere],
        slug: "iade",
      });
    });

    expect(outcome.changed).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: elsewhere, reason: "out_of_scope" }]);
  });

  it("is idempotent", async () => {
    const second = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const actor = await actorFor(fixture, fixture.admin, tx);
      await bulkTag(tx, actor, { reviewIds: ids, slug: "iade" });
      return bulkTag(tx, actor, { reviewIds: ids, slug: "iade" });
    });

    expect(second.changed).toEqual([]);
  });
});

describe("the bulk-reply guardrail", () => {
  let fixture: Fixture;
  let ids: string[];
  let templateId: string;

  beforeEach(async () => {
    fixture = await makeFixture(`guard-${counter++}`);
    ids = [await addReview(fixture), await addReview(fixture), await addReview(fixture)];

    templateId = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const template = await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Özür",
        body: "Merhaba {{author}}, yaşadığınız için özür dileriz.",
        language: "tr",
      });
      return template.id;
    });
  });

  it("writes drafts, and nothing but drafts", async () => {
    // The guardrail, stated as a test. Every reply a bulk action produces must
    // be `draft`: unapproved, unposted, and carrying no external id.
    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftFromTemplate(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        templateId,
      }),
    );

    const replies = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.organizationId, fixture.orgId));

    expect(replies).toHaveLength(3);
    for (const reply of replies) {
      expect(reply.status).toBe("draft");
      expect(reply.approvedAt).toBeNull();
      expect(reply.approvedByUserId).toBeNull();
      expect(reply.postedAt).toBeNull();
      expect(reply.externalId).toBeNull();
    }
  });

  it("fills each draft in for its own review", async () => {
    await getAdminDb()
      .update(schema.reviews)
      .set({ authorName: "Deniz" })
      .where(eq(schema.reviews.id, ids[0]!));

    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftFromTemplate(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        templateId,
      }),
    );

    const [reply] = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.reviewId, ids[0]!));

    expect(reply?.text).toContain("Deniz");
  });

  it("does not overwrite a reply somebody is already working on", async () => {
    await getAdminDb().insert(schema.replies).values({
      organizationId: fixture.orgId,
      reviewId: ids[0]!,
      text: "Half-written by a colleague.",
      status: "draft",
    });

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftFromTemplate(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        templateId,
      }),
    );

    expect(outcome.skipped).toContainEqual({ id: ids[0]!, reason: "already_replied" });

    const [existing] = await getAdminDb()
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.reviewId, ids[0]!));
    expect(existing?.text).toBe("Half-written by a colleague.");
  });

  it("respects location scope like every other bulk action", async () => {
    const elsewhere = await addReview(fixture, fixture.besiktas);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftFromTemplate(tx, await actorFor(fixture, fixture.scopedMember, tx), {
        reviewIds: [elsewhere],
        templateId,
      }),
    );

    expect(outcome.changed).toEqual([]);
    expect(
      await getAdminDb()
        .select()
        .from(schema.replies)
        .where(eq(schema.replies.reviewId, elsewhere)),
    ).toHaveLength(0);
  });

  it("cannot reach a template belonging to another organization", async () => {
    const neighbour = await makeFixture(`guard-other-${counter++}`);
    const theirTemplate = await withTenant({ organizationId: neighbour.orgId }, (tx) =>
      saveReplyTemplate(tx, {
        organizationId: neighbour.orgId,
        role: "admin",
        name: "Komşunun şablonu",
        body: "Merhaba!",
        language: "tr",
      }),
    );

    await expect(
      withTenant({ organizationId: fixture.orgId }, async (tx) =>
        bulkDraftFromTemplate(tx, await actorFor(fixture, fixture.admin, tx), {
          reviewIds: ids,
          templateId: theirTemplate.id,
        }),
      ),
    ).rejects.toThrow(TriageError);
  });
});

describe("bulk AI drafting", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`ai-${counter++}`);
  });

  /** Stands in for `draftReplyForReview`, which is covered by its own suite. */
  function recorder(failOn: string[] = []) {
    const drafted: string[] = [];
    return {
      drafted,
      draft: async (reviewId: string) => {
        if (failOn.includes(reviewId)) throw new Error("no");
        drafted.push(reviewId);
      },
    };
  }

  it("drafts for the whole selection", async () => {
    const ids = [await addReview(fixture), await addReview(fixture)];
    const spy = recorder();

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftWithAi(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        draft: spy.draft,
      }),
    );

    expect(spy.drafted.sort()).toEqual([...ids].sort());
    expect(outcome.changed.sort()).toEqual([...ids].sort());
  });

  it("keeps the drafts that succeeded when one review cannot be drafted", async () => {
    // An exhausted allowance, a source that takes no replies, an already
    // answered review — none of those should discard real work already done.
    const ids = [await addReview(fixture), await addReview(fixture)];
    const spy = recorder([ids[0]!]);

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftWithAi(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        draft: spy.draft,
      }),
    );

    expect(outcome.changed).toEqual([ids[1]!]);
    expect(outcome.skipped.map((entry) => entry.id)).toEqual([ids[0]!]);
  });

  it("stops at the model-call cap, however many are selected", async () => {
    // The cap is about latency, not the guardrail: each one is a model call
    // made while somebody waits.
    const ids: string[] = [];
    for (let index = 0; index < MAX_BULK_AI_DRAFTS + 3; index += 1) {
      ids.push(await addReview(fixture));
    }
    const spy = recorder();

    await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftWithAi(tx, await actorFor(fixture, fixture.admin, tx), {
        reviewIds: ids,
        draft: spy.draft,
      }),
    );

    expect(spy.drafted).toHaveLength(MAX_BULK_AI_DRAFTS);
  });

  it("never asks for a draft on a review outside the actor's scope", async () => {
    const elsewhere = await addReview(fixture, fixture.besiktas);
    const spy = recorder();

    const outcome = await withTenant({ organizationId: fixture.orgId }, async (tx) =>
      bulkDraftWithAi(tx, await actorFor(fixture, fixture.scopedMember, tx), {
        reviewIds: [elsewhere],
        draft: spy.draft,
      }),
    );

    expect(spy.drafted).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: elsewhere, reason: "out_of_scope" }]);
  });
});
