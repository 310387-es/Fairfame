import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { withinLimit } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { approveAllMatching, listDisplayCandidates, setDisplayApproval } from "@/widgets/approval";
import { DEFAULT_WIDGET_FILTERS } from "@/widgets/config";
import { createWidget, getWidget, listWidgets, updateWidget } from "@/widgets/store";
import { loadWidgetContent, resolveWidgetByKey } from "@/widgets/public";
import { subscribeToPlanWith } from "./plan-fixture";
import { dropFixtureUsers } from "./cleanup";

/**
 * The widget builder (P3-T1).
 *
 * The Definition of Done is "a user builds a widget in-app and it renders their
 * reviews on an external page", and the half worth testing is the join between
 * those two halves: that what the builder shows a business it is choosing
 * between is the same set the public endpoint will serve. A builder listing
 * candidates by one rule and a widget rendering by another is the failure this
 * file exists to catch, and it is invisible until a customer reports that a
 * review they approved never appeared.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = {
  orgId: string;
  userId: string;
  locationId: string;
  otherLocationId: string;
  reviewIds: string[];
};

async function makeFixture(): Promise<Fixture> {
  const label = `b${counter++}`;

  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: `Builder ${label} ${suffix}`, slug: `builder-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);
  await subscribeToPlanWith(org.id, ["widgets"]);

  const [user] = await getAdminDb()
    .insert(schema.users)
    .values({ email: `builder-${label}-${suffix}@example.com`, name: "Builder" })
    .returning({ id: schema.users.id });

  const locations = await getAdminDb()
    .insert(schema.locations)
    .values([
      { organizationId: org.id, name: `${label} Merkez`, locale: "tr" },
      { organizationId: org.id, name: `${label} Şube`, locale: "tr" },
    ])
    .returning({ id: schema.locations.id });

  const locationId = locations[0]!.id;

  const reviews = await getAdminDb()
    .insert(schema.reviews)
    .values([
      {
        organizationId: org.id,
        locationId,
        source: "google",
        sourceReviewId: `${label}-five`,
        rating: 5,
        text: "Beş yıldız, yazılı",
        postedAt: new Date("2026-07-20T10:00:00Z"),
        rawPayload: {},
      },
      {
        organizationId: org.id,
        locationId,
        source: "google",
        sourceReviewId: `${label}-four`,
        rating: 4,
        text: "Dört yıldız, yazılı",
        postedAt: new Date("2026-07-19T10:00:00Z"),
        rawPayload: {},
      },
      {
        organizationId: org.id,
        locationId,
        source: "instagram",
        sourceReviewId: `${label}-two`,
        rating: 2,
        text: "İki yıldız, yazılı",
        postedAt: new Date("2026-07-18T10:00:00Z"),
        rawPayload: {},
      },
      {
        organizationId: org.id,
        locationId,
        source: "instagram",
        itemType: "dm",
        sourceReviewId: `${label}-dm`,
        text: "Özel mesaj",
        postedAt: new Date("2026-07-17T10:00:00Z"),
        rawPayload: {},
      },
    ])
    .returning({ id: schema.reviews.id });

  return {
    orgId: org.id,
    userId: user!.id,
    locationId,
    otherLocationId: locations[1]!.id,
    reviewIds: reviews.map((review) => review.id),
  };
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeFixture();
});

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  // Organizations cascade; users do not — see `dropFixtureUsers`.
  await dropFixtureUsers(suffix);
  await closeDatabasePools();
});

const scopeOf = (widgetLocationId: string | null, sources: string[] = []) => ({
  organizationId: fixture.orgId,
  locationId: widgetLocationId,
  sources,
});

describe("creating and configuring", () => {
  it("starts unpublished, with a key that is not the id", async () => {
    const widget = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      createWidget(tx, {
        organizationId: fixture.orgId,
        name: "Ana sayfa",
        locationId: fixture.locationId,
      }),
    );

    expect(widget.published).toBe(false);
    expect(widget.publicKey).toMatch(/^[a-z0-9]{24}$/);
    expect(widget.publicKey).not.toBe(widget.id);
    // Defaults come from the schema, so a new widget is immediately renderable.
    expect(widget.style.layout).toBe("grid");
    expect(widget.filters.count).toBe(DEFAULT_WIDGET_FILTERS.count);
  });

  it("round-trips a configuration through the jsonb columns", async () => {
    const created = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      createWidget(tx, { organizationId: fixture.orgId, name: "X", locationId: null }),
    );

    const saved = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      updateWidget(tx, fixture.orgId, created.id, {
        filters: { ...DEFAULT_WIDGET_FILTERS, minRating: 4, sources: ["google"], count: 6 },
        style: {
          layout: "carousel",
          theme: "dark",
          locale: "en",
          accent: "#00695c",
          showAuthor: false,
          showSource: true,
          showDate: true,
        },
      }),
    );

    // Read back through a fresh query, not from the write's return value.
    const reread = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      getWidget(tx, fixture.orgId, created.id),
    );

    expect(saved?.style.theme).toBe("dark");
    expect(reread?.style).toEqual(saved?.style);
    expect(reread?.filters.minRating).toBe(4);
    expect(reread?.filters.sources).toEqual(["google"]);
  });

  it("keeps one organization's widgets out of another's list", async () => {
    const other = await makeFixture();

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      createWidget(tx, { organizationId: fixture.orgId, name: "Mine", locationId: null }),
    );

    const theirs = await withTenant({ organizationId: other.orgId }, (tx) =>
      listWidgets(tx, other.orgId),
    );

    expect(theirs).toHaveLength(0);
  });
});

describe("what the builder offers to approve", () => {
  it("lists unapproved reviews — otherwise nothing could ever be approved", async () => {
    const page = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listDisplayCandidates(tx, scopeOf(fixture.locationId), DEFAULT_WIDGET_FILTERS),
    );

    // Three reviews with text at this location; the DM is not among them.
    expect(page.matching).toBe(3);
    expect(page.approved).toBe(0);
    expect(page.candidates.map((candidate) => candidate.text)).not.toContain("Özel mesaj");
  });

  it("offers exactly what the widget would render, once approved", async () => {
    // The join this file exists for. Approve everything the builder listed
    // under one set of filters, then ask the *public* path what it serves.
    const filters = { ...DEFAULT_WIDGET_FILTERS, minRating: 4 };

    const widget = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const created = await createWidget(tx, {
        organizationId: fixture.orgId,
        name: "Match",
        locationId: fixture.locationId,
      });
      await updateWidget(tx, fixture.orgId, created.id, { filters, published: true });
      return created;
    });

    const offered = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listDisplayCandidates(tx, scopeOf(fixture.locationId), filters),
    );

    await withTenant({ organizationId: fixture.orgId }, (tx) =>
      setDisplayApproval(
        tx,
        { organizationId: fixture.orgId, actorUserId: fixture.userId, approved: true },
        offered.candidates.map((candidate) => candidate.id),
      ),
    );

    const resolved = await resolveWidgetByKey(widget.publicKey);
    const { reviews } = await loadWidgetContent(resolved!);

    expect(offered.candidates).toHaveLength(2);
    expect(reviews.map((review) => review.id).sort()).toEqual(
      offered.candidates.map((candidate) => candidate.id).sort(),
    );
  });

  it("narrows with the widget's own filters", async () => {
    const bySource = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listDisplayCandidates(tx, scopeOf(fixture.locationId, ["google"]), DEFAULT_WIDGET_FILTERS),
    );
    const byLocation = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listDisplayCandidates(tx, scopeOf(fixture.otherLocationId), DEFAULT_WIDGET_FILTERS),
    );

    expect(bySource.matching).toBe(2);
    expect(byLocation.matching).toBe(0);
  });
});

describe("approving", () => {
  it("records who and when, and is idempotent", async () => {
    const [first, second] = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const change = {
        organizationId: fixture.orgId,
        actorUserId: fixture.userId,
        approved: true,
      };
      return [
        await setDisplayApproval(tx, change, [fixture.reviewIds[0]!]),
        await setDisplayApproval(tx, change, [fixture.reviewIds[0]!]),
      ];
    });

    expect(first).toBe(1);
    // A second press must not re-stamp who approved it, or when.
    expect(second).toBe(0);

    const [row] = await getAdminDb()
      .select({
        at: schema.reviews.displayApprovedAt,
        by: schema.reviews.displayApprovedByUserId,
      })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, fixture.reviewIds[0]!));

    expect(row?.at).not.toBeNull();
    expect(row?.by).toBe(fixture.userId);
  });

  it("withdraws cleanly, clearing the signature with the flag", async () => {
    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const base = { organizationId: fixture.orgId, actorUserId: fixture.userId };
      await setDisplayApproval(tx, { ...base, approved: true }, [fixture.reviewIds[0]!]);
      await setDisplayApproval(tx, { ...base, approved: false }, [fixture.reviewIds[0]!]);
    });

    const [row] = await getAdminDb()
      .select({
        at: schema.reviews.displayApprovedAt,
        by: schema.reviews.displayApprovedByUserId,
      })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, fixture.reviewIds[0]!));

    // A stale "approved by" on an unapproved review would be a record of a
    // decision that no longer holds.
    expect(row?.at).toBeNull();
    expect(row?.by).toBeNull();
  });

  it("refuses a direct message even when handed its id directly", async () => {
    const dmId = fixture.reviewIds[3]!;

    const changed = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      setDisplayApproval(
        tx,
        { organizationId: fixture.orgId, actorUserId: fixture.userId, approved: true },
        [dmId],
      ),
    );

    // Not an error — the WHERE clause simply does not match one, so a caller
    // that built its own id list gets zero rather than a constraint violation.
    expect(changed).toBe(0);
  });

  it("cannot reach another organization's reviews", async () => {
    const other = await makeFixture();

    const changed = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      setDisplayApproval(
        tx,
        { organizationId: fixture.orgId, actorUserId: fixture.userId, approved: true },
        other.reviewIds,
      ),
    );

    expect(changed).toBe(0);
  });
});

describe("approving everything that matches", () => {
  it("covers exactly the filtered set, and logs what it covered", async () => {
    const filters = { ...DEFAULT_WIDGET_FILTERS, minRating: 4 };

    const changed = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      approveAllMatching(
        tx,
        { organizationId: fixture.orgId, actorUserId: fixture.userId },
        scopeOf(fixture.locationId),
        filters,
      ),
    );

    expect(changed).toBe(2);

    // The two-star review is outside the filter and must be untouched.
    const [twoStar] = await getAdminDb()
      .select({ at: schema.reviews.displayApprovedAt })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, fixture.reviewIds[2]!));
    expect(twoStar?.at).toBeNull();

    // One row for the action, carrying the filter — not 600 rows carrying
    // nothing. "Who approved this quote" has to have an answer.
    const logs = await getAdminDb()
      .select({ action: schema.auditLogs.action, meta: schema.auditLogs.meta })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, fixture.orgId));

    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe("review.display_approved");
    expect(logs[0]?.meta).toMatchObject({ affected: 2, filters: { minRating: 4 } });
  });

  it("is safe to run twice", async () => {
    const run = () =>
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        approveAllMatching(
          tx,
          { organizationId: fixture.orgId, actorUserId: fixture.userId },
          scopeOf(fixture.locationId),
          DEFAULT_WIDGET_FILTERS,
        ),
      );

    expect(await run()).toBe(3);
    expect(await run()).toBe(0);
  });
});

describe("the plan limit", () => {
  it("counts drafts as well as published widgets", async () => {
    // Otherwise "1 widget" would mean "1 at a time", and a business could keep
    // a drawer of nine and rotate them.
    await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await createWidget(tx, { organizationId: fixture.orgId, name: "Draft", locationId: null });
    });

    const check = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      withinLimit({ organizationId: fixture.orgId, tx }, "max_widgets"),
    );

    expect(check.current).toBe(1);
  });
});
