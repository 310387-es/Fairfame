import { describe, expect, it } from "vitest";
import { generateCorpus, THEMES } from "@/connectors/mock-data";
import { mockCapabilities, mockConnector, MOCK_PROVIDER } from "@/connectors/mock";
import { getConnector, hasConnector, listProviders } from "@/connectors/registry";
import { ConnectorError, type Connection } from "@/connectors/types";

const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORG_ID,
    locationId: LOCATION_ID,
    provider: MOCK_PROVIDER,
    status: "active",
    capabilities: mockCapabilities,
    config: {
      locationId: LOCATION_ID,
      backfillCount: 40,
      spanDays: 180,
      dripIntervalMinutes: null,
      seed: "",
      simulate: { failFetch: false, failReply: false, retryable: true },
    },
    encryptedTokens: null,
    cursor: null,
    lastSyncedAt: null,
    firstSyncedAt: null,
    nextSyncAt: null,
    failureCount: 0,
    // Fixed anchor: the mock's backfill hangs off this, so timestamps are
    // stable across fetches rather than sliding with the wall clock.
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("registry", () => {
  it("resolves the mock provider", () => {
    expect(getConnector(MOCK_PROVIDER).provider).toBe(MOCK_PROVIDER);
    expect(hasConnector(MOCK_PROVIDER)).toBe(true);
    expect(listProviders()).toContain(MOCK_PROVIDER);
  });

  it("refuses an unknown provider without retrying", () => {
    // "google" is no longer unknown — it is a catalogued provider that resolves
    // to a mock until its flag and credentials say otherwise (P1b-T0).
    expect(() => getConnector("yandex")).toThrow(ConnectorError);
    try {
      getConnector("yandex");
    } catch (error) {
      expect((error as ConnectorError).retryable).toBe(false);
    }
  });

  it("resolves a source we own without needing a configured environment", () => {
    // mock and firstparty have no flag to read, so asking the environment
    // about them would only add a way to fail.
    expect(getConnector("firstparty").provider).toBe("firstparty");
    expect(getConnector(MOCK_PROVIDER).capabilities.read).toBe("full");
  });
});

describe("mock capabilities", () => {
  it("declares the contract from the build plan", () => {
    expect(mockCapabilities).toEqual({ read: "full", reply: "api", realtime: false });
  });

  it("exposes postReply, since it claims reply: 'api'", () => {
    expect(typeof mockConnector.postReply).toBe("function");
  });
});

describe("corpus generation", () => {
  const corpus = generateCorpus({
    locationId: LOCATION_ID,
    count: 40,
    until: new Date("2026-08-01T00:00:00Z"),
  });

  it("produces the requested number of reviews", () => {
    expect(corpus).toHaveLength(40);
  });

  it("is deterministic for the same location — this is what makes dedup testable", () => {
    const again = generateCorpus({
      locationId: LOCATION_ID,
      count: 40,
      until: new Date("2026-08-01T00:00:00Z"),
    });

    expect(again.map((r) => r.id)).toEqual(corpus.map((r) => r.id));
    expect(again.map((r) => r.comment)).toEqual(corpus.map((r) => r.comment));
  });

  it("gives different locations different review ids", () => {
    const other = generateCorpus({
      locationId: "44444444-4444-4444-8444-444444444444",
      count: 40,
      until: new Date("2026-08-01T00:00:00Z"),
    });

    const overlap = new Set(corpus.map((r) => r.id));
    expect(other.some((review) => overlap.has(review.id))).toBe(false);
  });

  it("emits unique ids within a corpus", () => {
    expect(new Set(corpus.map((r) => r.id)).size).toBe(corpus.length);
  });

  it("covers both launch languages", () => {
    const languages = new Set(corpus.map((r) => r.language));
    expect(languages).toContain("tr");
    expect(languages).toContain("en");
  });

  it("varies rating across the whole 1–5 range", () => {
    const ratings = new Set(corpus.map((r) => r.rating));
    expect(ratings.size).toBeGreaterThanOrEqual(4);
    for (const rating of ratings) {
      expect(rating).toBeGreaterThanOrEqual(1);
      expect(rating).toBeLessThanOrEqual(5);
    }
  });

  it("includes recurring themes, which the Action Digest will later mine", () => {
    const seen = new Set(corpus.flatMap((r) => r.themes));
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const theme of seen) {
      expect(THEMES).toContain(theme);
    }
  });

  it("includes some owner replies but not all", () => {
    const replied = corpus.filter((r) => r.ownerReply !== undefined);
    expect(replied.length).toBeGreaterThan(0);
    expect(replied.length).toBeLessThan(corpus.length);
  });

  it("writes review text in the review's own language", () => {
    // A Turkish review containing only ASCII would suggest the language tag and
    // the content had drifted apart.
    const turkish = corpus.filter((r) => r.language === "tr");
    expect(turkish.some((r) => /[çğıöşüÇĞİÖŞÜ]/.test(r.comment))).toBe(true);
  });

  it("spreads reviews backwards over the requested span", () => {
    const until = new Date("2026-08-01T00:00:00Z");
    const times = corpus.map((r) => new Date(r.createdAt).getTime());

    expect(Math.max(...times)).toBeLessThanOrEqual(until.getTime());
    const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    expect(spanDays).toBeGreaterThan(150);
  });
});

describe("connect()", () => {
  it("returns an active connection carrying the declared capabilities", async () => {
    const draft = await mockConnector.connect(ORG_ID, { locationId: LOCATION_ID });

    expect(draft.organizationId).toBe(ORG_ID);
    expect(draft.locationId).toBe(LOCATION_ID);
    expect(draft.provider).toBe(MOCK_PROVIDER);
    expect(draft.status).toBe("active");
    expect(draft.capabilities).toEqual(mockCapabilities);
    // No credential material invented for a source that has none.
    expect(draft.encryptedTokens).toBeNull();
  });

  it("applies documented defaults", async () => {
    const draft = await mockConnector.connect(ORG_ID, { locationId: LOCATION_ID });
    expect(draft.config).toMatchObject({ backfillCount: 40, spanDays: 180 });
  });

  it("rejects a config without a location, and does not ask to be retried", async () => {
    await expect(mockConnector.connect(ORG_ID, {})).rejects.toThrow(ConnectorError);
    await expect(mockConnector.connect(ORG_ID, {})).rejects.toMatchObject({ retryable: false });
  });

  it("rejects a non-uuid location id", async () => {
    await expect(mockConnector.connect(ORG_ID, { locationId: "nope" })).rejects.toThrow(
      ConnectorError,
    );
  });
});

describe("fetchReviews()", () => {
  it("returns the full backfill when there is no cursor", async () => {
    const raw = await mockConnector.fetchReviews(connection());
    expect(raw).toHaveLength(40);
    expect(raw[0]?.sourceReviewId).toMatch(/^mock_/);
  });

  it("honours the configured backfill size", async () => {
    const raw = await mockConnector.fetchReviews(
      connection({ config: { locationId: LOCATION_ID, backfillCount: 12 } }),
    );
    expect(raw).toHaveLength(12);
  });

  it("returns only newer reviews when given a since", async () => {
    const all = await mockConnector.fetchReviews(connection());
    const times = all.map((r) => Date.parse(String(r.payload.createdAt)));
    const midpoint = new Date((Math.min(...times) + Math.max(...times)) / 2);

    const recent = await mockConnector.fetchReviews(connection(), midpoint);

    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThan(all.length);
    for (const review of recent) {
      expect(Date.parse(String(review.payload.createdAt))).toBeGreaterThan(midpoint.getTime());
    }
  });

  it("surfaces a simulated failure as a retryable ConnectorError", async () => {
    const failing = connection({
      config: { locationId: LOCATION_ID, simulate: { failFetch: true, retryable: true } },
    });

    await expect(mockConnector.fetchReviews(failing)).rejects.toThrow(ConnectorError);
    await expect(mockConnector.fetchReviews(failing)).rejects.toMatchObject({ retryable: true });
  });

  it("can simulate a permanent failure too", async () => {
    const failing = connection({
      config: { locationId: LOCATION_ID, simulate: { failFetch: true, retryable: false } },
    });
    await expect(mockConnector.fetchReviews(failing)).rejects.toMatchObject({ retryable: false });
  });

  it("places drip reviews exactly on their interval boundary", async () => {
    // Regression guard. The generator scatters timestamps backwards by up to an
    // hour, which is invisible across a 180-day backfill but fatal for a
    // one-minute drip: a scattered "new" review can land before the stored
    // cursor, so the incremental fetch never returns it and the drip silently
    // stops after the first batch.
    const intervalMinutes = 1;
    const raw = await mockConnector.fetchReviews(
      connection({
        config: {
          locationId: LOCATION_ID,
          backfillCount: 0,
          dripIntervalMinutes: intervalMinutes,
        },
      }),
    );

    expect(raw.length).toBeGreaterThan(0);

    const intervalMs = intervalMinutes * 60_000;
    for (const review of raw) {
      const at = Date.parse(String(review.payload.createdAt));
      expect(at % intervalMs, "drip timestamps must sit on the bucket boundary").toBe(0);
    }
  });

  it("makes each drip bucket strictly newer than the last", async () => {
    const raw = await mockConnector.fetchReviews(
      connection({
        config: { locationId: LOCATION_ID, backfillCount: 0, dripIntervalMinutes: 1 },
      }),
    );

    const times = raw.map((review) => Date.parse(String(review.payload.createdAt)));
    const ascending = [...times].sort((x, y) => x - y);

    expect(new Set(times).size).toBe(times.length);
    expect(times.slice().sort((x, y) => x - y)).toEqual(ascending);
  });

  it("emits extra drip reviews when a drip interval is configured", async () => {
    const withoutDrip = await mockConnector.fetchReviews(
      connection({ config: { locationId: LOCATION_ID, backfillCount: 10 } }),
    );
    const withDrip = await mockConnector.fetchReviews(
      connection({
        config: { locationId: LOCATION_ID, backfillCount: 10, dripIntervalMinutes: 5 },
      }),
    );

    expect(withDrip.length).toBeGreaterThan(withoutDrip.length);
  });

  it("rejects a malformed config rather than syncing nothing silently", async () => {
    const broken = connection({ config: { locationId: "not-a-uuid" } });
    await expect(mockConnector.fetchReviews(broken)).rejects.toThrow(ConnectorError);
  });
});

describe("normalize()", () => {
  it("maps a provider payload onto the canonical shape", async () => {
    const conn = connection();
    const [raw] = await mockConnector.fetchReviews(conn);
    if (!raw) throw new Error("expected at least one review");

    const canonical = mockConnector.normalize(conn, raw);

    expect(canonical.source).toBe(MOCK_PROVIDER);
    expect(canonical.sourceReviewId).toBe(raw.sourceReviewId);
    expect(canonical.locationId).toBe(LOCATION_ID);
    expect(canonical.authorName).toBeTruthy();
    expect(canonical.rating).toBeGreaterThanOrEqual(1);
    expect(canonical.postedAt).toBeInstanceOf(Date);
    expect(canonical.url).toContain("http");
  });

  it("always retains the untouched provider payload", async () => {
    const conn = connection();
    const [raw] = await mockConnector.fetchReviews(conn);
    if (!raw) throw new Error("expected at least one review");

    // raw_payload is the audit trail and the input for any future
    // re-normalization; losing it is unrecoverable.
    expect(mockConnector.normalize(conn, raw).rawPayload).toEqual(raw.payload);
  });

  it("takes the location from the connection, not from the payload", async () => {
    const conn = connection();
    const [raw] = await mockConnector.fetchReviews(conn);
    if (!raw) throw new Error("expected at least one review");

    const forged = {
      ...raw,
      payload: { ...raw.payload, locationId: "99999999-9999-4999-8999-999999999999" },
    };

    expect(mockConnector.normalize(conn, forged).locationId).toBe(LOCATION_ID);
  });

  it("rejects a payload that does not match the provider schema", () => {
    expect(() =>
      mockConnector.normalize(connection(), { sourceReviewId: "x", payload: { nope: true } }),
    ).toThrow(ConnectorError);
  });

  it("rejects an out-of-range rating instead of writing it", () => {
    const [sample] = generateCorpus({ locationId: LOCATION_ID, count: 1, until: new Date() });
    if (!sample) throw new Error("expected a sample");

    expect(() =>
      mockConnector.normalize(connection(), {
        sourceReviewId: sample.id,
        payload: { ...sample, rating: 9 },
      }),
    ).toThrow(ConnectorError);
  });
});

describe("nextCursor()", () => {
  it("returns the newest timestamp in the batch", async () => {
    const conn = connection();
    const raw = await mockConnector.fetchReviews(conn);

    const cursor = mockConnector.nextCursor?.(conn, raw);
    const newest = Math.max(...raw.map((r) => Date.parse(String(r.payload.createdAt))));

    expect(cursor).toBe(new Date(newest).toISOString());
  });

  it("returns null for an empty batch, leaving the cursor untouched", () => {
    expect(mockConnector.nextCursor?.(connection(), [])).toBeNull();
  });

  it("ignores an unparseable timestamp rather than stalling future syncs", () => {
    const cursor = mockConnector.nextCursor?.(connection(), [
      { sourceReviewId: "a", payload: { createdAt: "not-a-date" } },
      { sourceReviewId: "b", payload: { createdAt: "2026-08-01T00:00:00.000Z" } },
    ]);

    expect(cursor).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("postReply()", () => {
  it("accepts a reply and returns an external id", async () => {
    const result = await mockConnector.postReply?.(connection(), "mock_abc_bf_0", "Teşekkürler!");
    expect(result).toEqual({ ok: true, externalId: "mock_reply_mock_abc_bf_0" });
  });

  it("refuses empty text and marks it not worth retrying", async () => {
    const result = await mockConnector.postReply?.(connection(), "mock_abc_bf_0", "   ");
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("can simulate a retryable provider rejection", async () => {
    const result = await mockConnector.postReply?.(
      connection({ config: { locationId: LOCATION_ID, simulate: { failReply: true } } }),
      "mock_abc_bf_0",
      "Thanks!",
    );
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});
