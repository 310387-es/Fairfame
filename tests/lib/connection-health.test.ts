import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  connectionHealth,
  errorKindOf,
  MIN_STALE_MS,
  needsAttention,
  STALE_INTERVALS,
  type HealthInput,
} from "@/connections/health";
import { PROVIDERS } from "@/connectors/providers";

/**
 * Connection health (W4.2).
 *
 * Every judgement in this module is about time or about a value written by
 * something else, which is the pair of things that start lying quietly. The
 * tests below are mostly about the states *not* firing: a badge that is lit on
 * a healthy connection is worse than no badge, because it teaches the reader
 * to stop looking.
 */

const HOUR = 60 * 60 * 1_000;
const NOW = new Date("2026-08-06T12:00:00.000Z");

const base: HealthInput = {
  status: "active",
  lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000),
  failureCount: 0,
  lastErrorKind: null,
  needsReauth: false,
  syncIntervalMs: 5 * 60_000,
};

const health = (patch: Partial<HealthInput>) => connectionHealth({ ...base, ...patch }, NOW);

describe("a working connection reports nothing", () => {
  it("is healthy when it synced recently", () => {
    expect(health({})).toBe("healthy");
  });

  it("is healthy having never synced", () => {
    // Brand new. Calling this stale would light a warning on every connection
    // in the minute between connecting it and the first sweep.
    expect(health({ lastSyncedAt: null })).toBe("healthy");
  });

  it("is healthy for a push source with no polling interval", () => {
    // First-party and webhook sources are never polled, so "it has not synced
    // in a day" is the normal state and means nothing at all.
    expect(health({ syncIntervalMs: null, lastSyncedAt: new Date(0) })).toBe("healthy");
  });
});

describe("credentials that cannot be renewed", () => {
  it("asks for a reconnect before anything has failed", () => {
    // The whole point of saying it now: the next sync is the one that breaks,
    // and the business can fix it in advance.
    expect(health({ needsReauth: true })).toBe("reconnect");
  });

  it("asks for a reconnect on an auth error", () => {
    expect(health({ status: "error", lastErrorKind: "auth", failureCount: 1 })).toBe("reconnect");
  });

  it("does not report an expiring access token", () => {
    /**
     * The `docs/remediation-plan.md` correction, pinned. An access token
     * expires hourly by design and is renewed on the way to every call; a badge
     * driven off its expiry would be lit permanently. Only the absence of
     * anything to renew *with* is a health state, and that arrives here as
     * `needsReauth`.
     */
    expect(health({ needsReauth: false })).toBe("healthy");
  });
});

describe("rate limiting is not a fault", () => {
  it("reports limited rather than failing, however many times it happened", () => {
    // A busy source can rack up a dozen 429s in a morning. Sending somebody to
    // reconnect a connection that is working as designed is the failure here.
    expect(health({ status: "error", lastErrorKind: "rate_limit", failureCount: 12 })).toBe(
      "limited",
    );
  });

  it("is not something to act on", () => {
    expect(needsAttention("limited")).toBe(false);
    expect(needsAttention("healthy")).toBe(false);
    for (const state of ["setup", "reconnect", "failing", "stale"] as const) {
      expect(needsAttention(state), state).toBe(true);
    }
  });
});

describe("the failure nobody notices", () => {
  it("is stale when it has not synced in far longer than its own interval", () => {
    // `status` is still active and `last_error` is still null — every other
    // signal on the row says fine. A stopped worker looks exactly like this.
    const interval = 6 * HOUR;
    const missed = new Date(NOW.getTime() - interval * STALE_INTERVALS - HOUR);
    expect(health({ syncIntervalMs: interval, lastSyncedAt: missed })).toBe("stale");
  });

  it("is not stale one interval late", () => {
    const interval = 6 * HOUR;
    expect(health({ syncIntervalMs: interval, lastSyncedAt: new Date(NOW.getTime() - interval) })) //
      .toBe("healthy");
  });

  it("gives a fast-polling source a whole day before calling it stale", () => {
    /**
     * The floor. Six intervals of the mock's 30 seconds is three minutes, so
     * without `MIN_STALE_MS` a dev machine whose worker paused for a coffee
     * would show every source as stale — and a warning that is usually wrong is
     * one nobody reads when it is right.
     */
    const interval = 30_000;
    const justUnder = new Date(NOW.getTime() - MIN_STALE_MS + HOUR);
    expect(health({ syncIntervalMs: interval, lastSyncedAt: justUnder })).toBe("healthy");
  });
});

describe("setup and disconnection", () => {
  it("asks a half-finished connection to be finished", () => {
    expect(health({ status: "pending" })).toBe("setup");
  });

  it("treats a disconnected row as nothing to report", () => {
    // Callers filter these out; the function stays total rather than throwing
    // on a value its own type permits.
    expect(health({ status: "disconnected" })).toBe("healthy");
  });
});

describe("error kinds survive being written down", () => {
  it("recognises the three types that mean different things", () => {
    const named = (name: string) => Object.assign(new Error("boom"), { name });

    expect(errorKindOf(named("RateLimitError"))).toBe("rate_limit");
    expect(errorKindOf(named("OAuthError"))).toBe("auth");
    expect(errorKindOf(named("GoogleAccessError"))).toBe("access");
  });

  it("falls back to other for anything it has not met", () => {
    expect(errorKindOf(new Error("boom"))).toBe("other");
    expect(errorKindOf("a string")).toBe("other");
    expect(errorKindOf(null)).toBe("other");
  });

  it("reports an unknown persisted kind as failing rather than as healthy", () => {
    /**
     * Forwards compatibility, in the safe direction. A row written by a later
     * version carries a kind this one has never heard of; the connection is
     * still erroring and must still be reported as erroring, just less
     * specifically. Reading it as healthy would hide a real fault behind a
     * deploy order.
     */
    expect(health({ status: "error", lastErrorKind: "something_new", failureCount: 3 })).toBe(
      "failing",
    );
    expect(health({ status: "error", lastErrorKind: null, failureCount: 3 })).toBe("failing");
  });
});

/**
 * A22-B4 — the English fallback must never be what a customer reads.
 *
 * `GoLiveNote` and its client twin fall back to the descriptor's own note, which
 * is written for whoever is wiring the connector. That fallback is deliberate —
 * a provider added later says something a developer wrote rather than a raw key
 * on the one screen somebody visits to find out why nothing is arriving — but it
 * is a *safety net*, not a plan. A provider that ships with a note and no
 * translation renders an English sentence under a Turkish heading, which is the
 * product telling somebody it was not built for them.
 *
 * Hunting the live instance of this would have been hunting a ghost: today every
 * provider with a note has both translations. What this does is stop the next
 * one arriving without them.
 */
describe("every go-live note has been translated", () => {
  const LOCALES = ["en", "tr"] as const;

  it("has a message for each provider that carries one", () => {
    const missing: string[] = [];

    for (const descriptor of Object.values(PROVIDERS)) {
      if (!descriptor.goLiveNote) continue;

      for (const locale of LOCALES) {
        const messages = JSON.parse(
          readFileSync(`src/i18n/messages/${locale}.json`, "utf8"),
        ) as Record<string, Record<string, Record<string, string>>>;

        if (!messages.connections?.goLive?.[descriptor.key]) {
          missing.push(`${locale}: connections.goLive.${descriptor.key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
