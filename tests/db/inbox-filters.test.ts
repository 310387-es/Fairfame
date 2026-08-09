import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import type { ReviewStatus } from "@/db/schema";
import { EMPTY_INBOX_FILTERS, type InboxFilterState } from "@/reviews/filters";
import {
  countInbox,
  decodeCursor,
  inboxFacets,
  listInbox,
  locateReview,
  toInboxFilters,
  type InboxFilters,
} from "@/reviews/queries";
import { withTenant } from "@/lib/tenancy";

/**
 * The unified inbox query (P2-T2).
 *
 * The Definition of Done: "every filter combines correctly, scoped to the active
 * location, paginated." Three claims, and each is a place this could go wrong
 * quietly — a filter that widens instead of narrows, a location leak that only
 * shows up for a two-location tenant, a pager that skips a row at the seam.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = {
  orgId: string;
  locationId: string;
  otherLocationId: string;
  alice: string;
  bob: string;
};

type ReviewSpec = {
  source?: string;
  rating?: number | null;
  text?: string;
  authorName?: string;
  sentiment?: "positive" | "neutral" | "negative";
  topics?: string[];
  status?: ReviewStatus;
  assignee?: string | null;
  /** Minutes into the past. Distinct values keep the order deterministic. */
  agoMinutes?: number;
  /** Hours from now; negative means already breached. */
  slaInHours?: number | null;
  locationId?: string;
  reply?: "draft" | "approved" | "posted" | "failed";
};

async function makeFixture(label: string): Promise<Fixture> {
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Filters ${label} ${suffix}`, slug: `filters-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} A` },
      { organizationId: org.id, name: `${label} B` },
    ])
    .returning({ id: schema.locations.id });

  const users = await getAdminDb()
    .insert(schema.users)
    .values([
      { email: `alice-${label}-${suffix}@example.com`, name: "Alice" },
      { email: `bob-${label}-${suffix}@example.com`, name: "Bob" },
    ])
    .returning({ id: schema.users.id });

  for (const user of users) {
    await getAdminDb()
      .insert(schema.memberships)
      .values({ organizationId: org.id, userId: user.id, role: "member" });
  }

  return {
    orgId: org.id,
    locationId: locations[0]!.id,
    otherLocationId: locations[1]!.id,
    alice: users[0]!.id,
    bob: users[1]!.id,
  };
}

async function addReview(fixture: Fixture, spec: ReviewSpec = {}): Promise<string> {
  const index = counter++;
  const postedAt = new Date(Date.now() - (spec.agoMinutes ?? index + 1) * 60_000);

  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: spec.locationId ?? fixture.locationId,
      source: spec.source ?? "mock",
      sourceReviewId: `f-${suffix}-${index}`,
      authorName: spec.authorName ?? "Mehmet",
      rating: spec.rating === undefined ? 4 : spec.rating,
      text: spec.text ?? "Bir yorum.",
      postedAt,
      rawPayload: {},
      status: spec.status ?? "open",
      assigneeUserId: spec.assignee ?? null,
      slaDueAt:
        spec.slaInHours === undefined || spec.slaInHours === null
          ? null
          : new Date(Date.now() + spec.slaInHours * 3_600_000),
    })
    .returning({ id: schema.reviews.id });
  if (!review) throw new Error("review insert returned nothing");

  if (spec.sentiment || spec.topics) {
    await getAdminDb()
      .insert(schema.reviewInsights)
      .values({
        organizationId: fixture.orgId,
        reviewId: review.id,
        sentiment: spec.sentiment ?? "neutral",
        sentimentScore: spec.sentiment === "negative" ? -0.7 : 0.3,
        topics: spec.topics ?? [],
        promptId: "test",
        model: "test",
      });
  }

  if (spec.reply) {
    await getAdminDb()
      .insert(schema.replies)
      .values({
        organizationId: fixture.orgId,
        reviewId: review.id,
        text: "Teşekkürler.",
        status: spec.reply,
        // `postReply` writes the status and the timestamp together, and every
        // reader asks the timestamp (A22-A4).
        ...(spec.reply === "posted" ? { postedAt: new Date() } : {}),
      });
  }

  return review.id;
}

/** Runs a read the way the page does: state → filters → query. */
async function list(
  fixture: Fixture,
  state: Partial<InboxFilterState> = {},
  extra: Partial<InboxFilters> = {},
  userId?: string,
) {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    listInbox(tx, fixture.orgId, fixture.locationId, {
      ...toInboxFilters({ ...EMPTY_INBOX_FILTERS, ...state }, { userId }),
      ...extra,
    }),
  );
}

async function ids(
  fixture: Fixture,
  state: Partial<InboxFilterState> = {},
  userId?: string,
): Promise<string[]> {
  return (await list(fixture, state, {}, userId)).rows.map((row) => row.id);
}

async function count(
  fixture: Fixture,
  state: Partial<InboxFilterState> = {},
  userId?: string,
): Promise<number> {
  return withTenant({ organizationId: fixture.orgId }, (tx) =>
    countInbox(
      tx,
      fixture.orgId,
      fixture.locationId,
      toInboxFilters({ ...EMPTY_INBOX_FILTERS, ...state }, { userId }),
    ),
  );
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("the workflow filters", () => {
  let fixture: Fixture;
  let open: string;
  let inProgress: string;
  let done: string;
  let mine: string;

  beforeAll(async () => {
    fixture = await makeFixture("workflow");
    open = await addReview(fixture, { status: "open", agoMinutes: 10 });
    inProgress = await addReview(fixture, {
      status: "in_progress",
      assignee: fixture.bob,
      agoMinutes: 20,
    });
    done = await addReview(fixture, { status: "done", agoMinutes: 30 });
    mine = await addReview(fixture, { status: "open", assignee: fixture.alice, agoMinutes: 40 });
  });

  it("filters by a single status", async () => {
    expect(await ids(fixture, { status: ["in_progress"] })).toEqual([inProgress]);
  });

  it("filters by several statuses at once", async () => {
    expect(await ids(fixture, { status: ["open", "done"] })).toEqual([open, done, mine]);
  });

  it("treats an empty status list as every status", async () => {
    expect(await ids(fixture, { status: [] })).toHaveLength(4);
  });

  it("filters by assignee", async () => {
    expect(await ids(fixture, { assignee: fixture.bob })).toEqual([inProgress]);
  });

  it("resolves `me` to the reader", async () => {
    expect(await ids(fixture, { assignee: "me" }, fixture.alice)).toEqual([mine]);
    expect(await ids(fixture, { assignee: "me" }, fixture.bob)).toEqual([inProgress]);
  });

  it("shows nothing for `me` when nobody is asking", async () => {
    // A shared saved view read by a job has no reader. Empty is the honest
    // answer; the whole inbox would be a leak of somebody else's queue.
    expect(await ids(fixture, { assignee: "me" })).toEqual([]);
  });

  it("filters by unassigned", async () => {
    expect(await ids(fixture, { assignee: "unassigned" })).toEqual([open, done]);
  });

  it("carries the assignee's name onto the row", async () => {
    const page = await list(fixture, { assignee: fixture.bob });

    expect(page.rows[0]?.assignee).toEqual({ id: fixture.bob, name: "Bob" });
  });
});

describe("the content filters", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("content");
    await addReview(fixture, { rating: 1, text: "Servis çok yavaştı", agoMinutes: 10 });
    await addReview(fixture, { rating: 2, text: "Kahve soğuktu", agoMinutes: 20 });
    await addReview(fixture, { rating: 5, text: "Harika bir servis", agoMinutes: 30 });
    await addReview(fixture, { rating: null, text: "Yorum", agoMinutes: 40 });
  });

  it("filters by a set of star ratings", async () => {
    expect(await count(fixture, { rating: [1, 2] })).toBe(2);
  });

  it("excludes unrated items when a rating is chosen", async () => {
    // A comment has no stars to give, so it cannot satisfy "one or two stars".
    expect(await count(fixture, { rating: [1, 2, 3, 4, 5] })).toBe(3);
  });

  it("matches every word of a search, in any order", async () => {
    // The single `LIKE '%yavaş servis%'` this replaced found nothing here.
    expect(await count(fixture, { query: "yavaş servis" })).toBe(1);
    expect(await count(fixture, { query: "servis yavaş" })).toBe(1);
  });

  it("still matches fragments, which is what people type in Turkish", async () => {
    expect(await count(fixture, { query: "servi" })).toBe(2);
  });

  it("ignores case and diacritics", async () => {
    expect(await count(fixture, { query: "YAVASTI" })).toBe(1);
  });

  it("narrows rather than widens as words are added", async () => {
    const one = await count(fixture, { query: "servis" });
    const two = await count(fixture, { query: "servis yavaş" });

    expect(two).toBeLessThan(one);
  });
});

describe("the date filters", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("dates");

    const at = async (iso: string) => {
      const [row] = await getAdminDb()
        .insert(schema.reviews)
        .values({
          organizationId: fixture.orgId,
          locationId: fixture.locationId,
          source: "mock",
          sourceReviewId: `d-${suffix}-${counter++}`,
          rating: 4,
          text: iso,
          postedAt: new Date(iso),
          rawPayload: {},
        })
        .returning({ id: schema.reviews.id });
      return row!.id;
    };

    await at("2026-07-01T00:00:00.000Z");
    await at("2026-07-15T12:00:00.000Z");
    // The last instant of the 31st: the boundary an inclusive "to" must include.
    await at("2026-07-31T23:59:59.000Z");
    await at("2026-08-01T00:00:00.000Z");
  });

  it("includes the whole of the closing day", async () => {
    expect(await count(fixture, { from: "2026-07-01", to: "2026-07-31" })).toBe(3);
  });

  it("excludes the day after", async () => {
    expect(await count(fixture, { to: "2026-07-31" })).toBe(3);
  });

  it("includes the opening day from its first instant", async () => {
    expect(await count(fixture, { from: "2026-07-01" })).toBe(4);
    expect(await count(fixture, { from: "2026-07-02" })).toBe(3);
  });
});

describe("the overdue filter", () => {
  let fixture: Fixture;
  let breached: string;

  beforeAll(async () => {
    fixture = await makeFixture("overdue");
    breached = await addReview(fixture, { slaInHours: -2, status: "open", agoMinutes: 10 });
    await addReview(fixture, { slaInHours: 5, status: "open", agoMinutes: 20 });
    // Late, but finished — which is not the same thing as overdue.
    await addReview(fixture, { slaInHours: -8, status: "done", agoMinutes: 30 });
    await addReview(fixture, { slaInHours: null, status: "open", agoMinutes: 40 });
  });

  it("does not count a review that was answered late", async () => {
    // `slaState()` calls this one "answered late", not "overdue" — nobody is
    // waiting on it any more. The filter has to agree with the badge on the
    // very row it returns.
    const answered = await addReview(fixture, { slaInHours: -6, status: "open", agoMinutes: 5 });
    await getAdminDb()
      .update(schema.reviews)
      .set({ firstResponseAt: new Date() })
      .where(eq(schema.reviews.id, answered));

    expect(await ids(fixture, { overdue: true })).not.toContain(answered);

    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );
    expect(facets.overdue).toBe(await count(fixture, { overdue: true }));
  });

  it("selects only unresolved items past their deadline", async () => {
    expect(await ids(fixture, { overdue: true })).toEqual([breached]);
  });

  it("agrees with the facet count", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );

    expect(facets.overdue).toBe(1);
  });
});

describe("filters combining", () => {
  let fixture: Fixture;
  let target: string;

  beforeAll(async () => {
    fixture = await makeFixture("combine");
    target = await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "negative",
      topics: ["servis"],
      status: "open",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 10,
    });
    // Each of these differs from the target in exactly one respect.
    await addReview(fixture, {
      source: "instagram",
      rating: 1,
      sentiment: "negative",
      topics: ["servis"],
      status: "open",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 20,
    });
    await addReview(fixture, {
      source: "google",
      rating: 5,
      sentiment: "negative",
      topics: ["servis"],
      status: "open",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 30,
    });
    await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "positive",
      topics: ["servis"],
      status: "open",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 40,
    });
    await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "negative",
      topics: ["fiyat"],
      status: "open",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 50,
    });
    await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "negative",
      topics: ["servis"],
      status: "done",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 60,
    });
    await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "negative",
      topics: ["servis"],
      status: "open",
      assignee: fixture.bob,
      text: "Servis berbattı",
      slaInHours: -1,
      agoMinutes: 70,
    });
    await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "negative",
      topics: ["servis"],
      status: "open",
      assignee: fixture.alice,
      text: "Kahve soğuktu",
      slaInHours: -1,
      agoMinutes: 80,
    });
    await addReview(fixture, {
      source: "google",
      rating: 1,
      sentiment: "negative",
      topics: ["servis"],
      status: "open",
      assignee: fixture.alice,
      text: "Servis berbattı",
      slaInHours: 9,
      agoMinutes: 90,
    });
  });

  const everything: Partial<InboxFilterState> = {
    source: "google",
    rating: [1],
    sentiment: "negative",
    theme: "servis",
    status: ["open"],
    assignee: "me",
    query: "servis berbat",
    overdue: true,
  };

  it("ANDs every filter together", async () => {
    // Nine rows, eight of which differ in exactly one filtered respect.
    expect(await ids(fixture, everything, fixture.alice)).toEqual([target]);
  });

  it("counts exactly what it lists", async () => {
    // The pager and the list must never disagree — same predicate, one place.
    expect(await count(fixture, everything, fixture.alice)).toBe(1);
  });

  it("scopes to the active location", async () => {
    await addReview(fixture, {
      locationId: fixture.otherLocationId,
      source: "google",
      rating: 1,
      status: "open",
    });

    const rows = await ids(fixture, { source: "google", rating: [1] });
    const other = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listInbox(tx, fixture.orgId, fixture.otherLocationId, {}),
    );

    expect(rows).not.toContain(other.rows[0]?.id);
    expect(other.rows).toHaveLength(1);
  });
});

describe("pagination", () => {
  let fixture: Fixture;
  let ordered: string[];

  beforeAll(async () => {
    fixture = await makeFixture("paging");
    ordered = [];
    for (let index = 0; index < 7; index += 1) {
      ordered.push(await addReview(fixture, { agoMinutes: index + 1, rating: 5 - (index % 5) }));
    }
  });

  it("walks the whole list with a keyset cursor, without repeating or skipping", async () => {
    const seen: string[] = [];
    let cursor = null;

    for (let guard = 0; guard < 10; guard += 1) {
      const page = await list(fixture, {}, { limit: 3, cursor });
      seen.push(...page.rows.map((row) => row.id));
      if (!page.nextCursor) break;
      cursor = decodeCursor(page.nextCursor);
    }

    expect(seen).toEqual(ordered);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("agrees with offset paging over the same order", async () => {
    const byOffset: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const rows = await list(fixture, {}, { limit: 3, offset: page * 3 });
      byOffset.push(...rows.rows.map((row) => row.id));
    }

    expect(byOffset).toEqual(ordered);
  });

  it("does not repeat a row when one is ingested mid-scroll", async () => {
    // The reason keyset exists: an offset re-reads by position, so a new arrival
    // at the top pushes everything down and the reader sees a card twice.
    const first = await list(fixture, {}, { limit: 3 });
    await addReview(fixture, { agoMinutes: 0 });

    const second = await list(fixture, {}, { limit: 3, cursor: decodeCursor(first.nextCursor) });

    expect(second.rows.map((row) => row.id)).toEqual(ordered.slice(3, 6));
  });

  it("keeps the filters while paging", async () => {
    const page = await list(fixture, { rating: [5] }, { limit: 1 });
    const next = await list(
      fixture,
      { rating: [5] },
      { limit: 1, cursor: decodeCursor(page.nextCursor) },
    );

    for (const row of [...page.rows, ...next.rows]) {
      expect(row.rating).toBe(5);
    }
  });

  it("starts from the top when the cursor is nonsense", async () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":"nope"}').toString("base64url"))).toBeNull();
  });
});

describe("sorting by priority", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("sort");
    // Oldest but angriest, and newest but happiest: the two orders disagree.
    await addReview(fixture, { rating: 5, agoMinutes: 5 });
    await addReview(fixture, { rating: 1, sentiment: "negative", agoMinutes: 500 });

    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const { refreshPriority } = await import("@/reviews/workflow");
      const rows = await tx.select({ id: schema.reviews.id }).from(schema.reviews);
      await refreshPriority(
        tx,
        fixture.orgId,
        rows.map((row) => row.id),
      );
    });
  });

  it("puts the angriest first, not the newest", async () => {
    const recent = await list(fixture, { sort: "recent" });
    const priority = await list(fixture, { sort: "priority" });

    expect(recent.rows[0]?.rating).toBe(5);
    expect(priority.rows[0]?.rating).toBe(1);
  });

  it("locates a review on the page it is actually on, under either sort", async () => {
    const priority = await list(fixture, { sort: "priority" });
    const last = priority.rows.at(-1)!;

    const page = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      locateReview(
        tx,
        fixture.orgId,
        fixture.locationId,
        last.id,
        toInboxFilters({ ...EMPTY_INBOX_FILTERS, sort: "priority" }),
        1,
      ),
    );

    expect(page).toBe(priority.rows.length);
  });
});

describe("facets", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await makeFixture("facets");
    await addReview(fixture, { status: "open", assignee: fixture.alice, slaInHours: -1 });
    await addReview(fixture, { status: "open" });
    await addReview(fixture, { status: "done", reply: "posted" });
  });

  it("counts the statuses and the quick filters the bar offers", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId, { userId: fixture.alice }),
    );

    expect(facets.statuses).toEqual([
      { value: "open", count: 2 },
      { value: "done", count: 1 },
    ]);
    expect(facets.mine).toBe(1);
    expect(facets.unassigned).toBe(2);
    expect(facets.overdue).toBe(1);
    expect(facets.unanswered).toBe(2);
    expect(facets.total).toBe(3);
  });

  it("counts nobody's queue when there is no reader", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId),
    );

    expect(facets.mine).toBe(0);
  });

  it("matches what the equivalent filter would return", async () => {
    const facets = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      inboxFacets(tx, fixture.orgId, fixture.locationId, { userId: fixture.alice }),
    );

    // A chip that promises three and shows two is worse than no chip at all.
    expect(await count(fixture, { assignee: "me" }, fixture.alice)).toBe(facets.mine);
    expect(await count(fixture, { overdue: true })).toBe(facets.overdue);
    expect(await count(fixture, { status: ["open"] })).toBe(
      facets.statuses.find((entry) => entry.value === "open")?.count,
    );
  });
});

describe("tenant isolation", () => {
  it("cannot read another organization's reviews through the inbox query", async () => {
    const mine = await makeFixture("iso-mine");
    const theirs = await makeFixture("iso-theirs");
    await addReview(theirs, { text: "Komşunun yorumu" });

    // Asking for the neighbour's organization *and* location by id, from inside
    // our own tenant context. The predicate itself would happily match those
    // rows; it is RLS that returns nothing, which is the point — isolation must
    // not depend on the query remembering to be careful.
    const rows = await withTenant({ organizationId: mine.orgId }, (tx) =>
      listInbox(tx, theirs.orgId, theirs.locationId, {}),
    );

    expect(rows.rows).toEqual([]);

    const leaked = await withTenant({ organizationId: mine.orgId }, (tx) =>
      countInbox(tx, theirs.orgId, theirs.locationId, {}),
    );

    expect(leaked).toBe(0);

    // And the same read succeeds for the tenant that owns the rows, so the
    // assertion above is testing the boundary rather than an empty fixture.
    const owned = await withTenant({ organizationId: theirs.orgId }, (tx) =>
      listInbox(tx, theirs.orgId, theirs.locationId, {}),
    );

    expect(owned.rows).toHaveLength(1);
  });

  it("cannot reach another organization's user through the assignee filter", async () => {
    const mine = await makeFixture("iso-assignee");
    const theirs = await makeFixture("iso-assignee-other");
    await addReview(theirs, { assignee: theirs.alice });

    const rows = await withTenant({ organizationId: mine.orgId }, (tx) =>
      listInbox(tx, mine.orgId, mine.locationId, { assignee: theirs.alice }),
    );

    expect(rows.rows).toEqual([]);
  });
});

describe("the review that was already there", () => {
  it("still reports a failed-only reply as unanswered", async () => {
    const fixture = await makeFixture("regression");
    const id = await addReview(fixture, { reply: "failed" });

    expect(await ids(fixture, { reply: "unanswered" })).toEqual([id]);

    // Both columns, as `postReply` writes them: "answered" is measured from the
    // moment the reply went out, not from the status beside it (A22-A4).
    await getAdminDb()
      .update(schema.replies)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(schema.replies.reviewId, id));

    expect(await ids(fixture, { reply: "unanswered" })).toEqual([]);
    expect(await ids(fixture, { reply: "answered" })).toEqual([id]);
  });
});
