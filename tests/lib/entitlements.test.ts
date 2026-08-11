import { describe, expect, it } from "vitest";
import {
  currentPeriod,
  resolveEntitlements,
  scalePerLocation,
  type SubscriptionSnapshot,
} from "@/lib/entitlements";
import { DEFAULT_PLAN_KEY, PLAN_CATALOG, TRIAL_PLAN_KEY } from "@/lib/plans";

const NOW = new Date("2026-08-01T12:00:00Z");
const FUTURE = new Date("2026-08-20T12:00:00Z");
const PAST = new Date("2026-07-20T12:00:00Z");

function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    planKey: "growth",
    status: "active",
    currentPeriodEnd: FUTURE,
    ...overrides,
  };
}

describe("resolveEntitlements", () => {
  it("falls back to the default plan when there is no subscription", () => {
    const resolved = resolveEntitlements(null, NOW);

    expect(resolved.effectivePlanKey).toBe(DEFAULT_PLAN_KEY);
    expect(resolved.isTrialing).toBe(false);
    // Degraded, not locked out — a billing glitch must not brick the account.
    expect(resolved.entitlements.features.ai_replies).toBe(true);
    expect(resolved.entitlements.features.white_label).toBe(false);
  });

  it("grants top-tier entitlements during a live trial", () => {
    const resolved = resolveEntitlements(
      subscription({ status: "trialing", planKey: "starter", currentPeriodEnd: FUTURE }),
      NOW,
    );

    expect(resolved.isTrialing).toBe(true);
    expect(resolved.effectivePlanKey).toBe(TRIAL_PLAN_KEY);
    expect(resolved.entitlements).toEqual(PLAN_CATALOG[TRIAL_PLAN_KEY].entitlements);
  });

  it("drops an expired trial to the default plan, not to the trial tier", () => {
    const resolved = resolveEntitlements(
      subscription({ status: "trialing", planKey: "starter", currentPeriodEnd: PAST }),
      NOW,
    );

    expect(resolved.isTrialing).toBe(false);
    expect(resolved.effectivePlanKey).toBe(DEFAULT_PLAN_KEY);
    // The specific regression this guards: an expired trial must not keep
    // white-label or unlimited locations.
    expect(resolved.entitlements.features.white_label).toBe(false);
    expect(resolved.entitlements.limits.max_locations).toBe(1);
  });

  it("applies the paid plan when active", () => {
    const resolved = resolveEntitlements(subscription({ planKey: "pro" }), NOW);

    expect(resolved.effectivePlanKey).toBe("pro");
    expect(resolved.entitlements.features.api_access).toBe(true);
    expect(resolved.entitlements.features.white_label).toBe(false);
  });

  it("keeps the paid plan while past_due — dunning is a grace period", () => {
    const resolved = resolveEntitlements(subscription({ planKey: "pro", status: "past_due" }), NOW);

    expect(resolved.effectivePlanKey).toBe("pro");
    expect(resolved.entitlements.features.benchmarking).toBe(true);
  });

  it.each(["canceled", "incomplete"] as const)("downgrades on %s", (status) => {
    const resolved = resolveEntitlements(subscription({ planKey: "agency", status }), NOW);

    expect(resolved.effectivePlanKey).toBe(DEFAULT_PLAN_KEY);
    expect(resolved.entitlements.features.white_label).toBe(false);
  });

  it("treats a null current_period_end as open-ended rather than expired", () => {
    const resolved = resolveEntitlements(
      subscription({ status: "trialing", currentPeriodEnd: null }),
      NOW,
    );

    expect(resolved.isTrialing).toBe(true);
  });
});

describe("overrides", () => {
  it("can grant a feature the plan does not include", () => {
    const resolved = resolveEntitlements(
      subscription({ planKey: "starter", overrides: { features: { social_sources: true } } }),
      NOW,
    );

    expect(resolved.entitlements.features.social_sources).toBe(true);
    // Untouched keys still come from the plan.
    expect(resolved.entitlements.features.white_label).toBe(false);
    expect(resolved.effectivePlanKey).toBe("starter");
  });

  it("can raise a numeric limit for a custom deal", () => {
    const resolved = resolveEntitlements(
      subscription({ planKey: "starter", overrides: { limits: { max_locations: 25 } } }),
      NOW,
    );

    expect(resolved.entitlements.limits.max_locations).toBe(25);
    // Untouched keys still come from the plan, not from the override.
    expect(resolved.entitlements.limits.max_team_members).toBe(
      PLAN_CATALOG.starter.entitlements.limits.max_team_members,
    );
  });

  it("can revoke a feature the plan includes", () => {
    const resolved = resolveEntitlements(
      subscription({ planKey: "pro", overrides: { features: { api_access: false } } }),
      NOW,
    );

    expect(resolved.entitlements.features.api_access).toBe(false);
  });

  it("ignores a malformed overrides blob instead of failing the request", () => {
    const resolved = resolveEntitlements(
      subscription({ planKey: "pro", overrides: { features: { api_access: "yes-please" } } }),
      NOW,
    );

    // Falls back to plan values rather than crashing or coercing a truthy string.
    expect(resolved.entitlements).toEqual(PLAN_CATALOG.pro.entitlements);
  });

  it("ignores unknown override keys", () => {
    const resolved = resolveEntitlements(
      subscription({ planKey: "pro", overrides: { features: { time_travel: true } } }),
      NOW,
    );

    expect(resolved.entitlements).toEqual(PLAN_CATALOG.pro.entitlements);
  });
});

describe("behaviour follows config, not code", () => {
  // The point of the primitive: no `if (plan === "pro")` anywhere. Every tier's
  // answer for every feature must be exactly what the catalog says.
  it.each(["starter", "growth", "pro", "agency"] as const)(
    "%s answers every feature straight from the catalog",
    (planKey) => {
      const resolved = resolveEntitlements(subscription({ planKey }), NOW);
      expect(resolved.entitlements.features).toEqual(PLAN_CATALOG[planKey].entitlements.features);
      expect(resolved.entitlements.limits).toEqual(PLAN_CATALOG[planKey].entitlements.limits);
    },
  );
});

/**
 * Per-location quotas (11 Aug 2026 repricing — docs/05 §1–2).
 *
 * Billing is per location, so allowances scale with it. The catalog stores the
 * single-branch figure; these pin what happens to it, because the difference
 * between "1,000 analyses" and "1,000 per branch" is the difference between a
 * five-branch account working and being throttled on the fourth day.
 */
describe("scalePerLocation", () => {
  const growth = PLAN_CATALOG.growth.entitlements;

  it("multiplies the per-location limits and metered allowances", () => {
    const scaled = scalePerLocation(growth, 5);

    expect(scaled.limits.ai_analyses_per_month).toBe(
      (growth.limits.ai_analyses_per_month ?? 0) * 5,
    );
    expect(scaled.metered.sms_credits).toBe((growth.metered.sms_credits ?? 0) * 5);
    expect(scaled.metered.whatsapp_conversations).toBe(
      (growth.metered.whatsapp_conversations ?? 0) * 5,
    );
    expect(scaled.metered.ai_tokens).toBe((growth.metered.ai_tokens ?? 0) * 5);
  });

  it("leaves the absolute limits alone", () => {
    // A location cap that multiplied by the location count would raise itself
    // every time somebody hit it, and one branch would become unlimited ones.
    const scaled = scalePerLocation(growth, 5);

    expect(scaled.limits.max_locations).toBe(growth.limits.max_locations);
    expect(scaled.limits.max_team_members).toBe(growth.limits.max_team_members);
    expect(scaled.limits.max_widgets).toBe(growth.limits.max_widgets);
  });

  it("keeps null as null — unlimited never multiplies into a number", () => {
    const scaled = scalePerLocation(PLAN_CATALOG.agency.entitlements, 40);

    expect(scaled.limits.ai_analyses_per_month).toBeNull();
    expect(scaled.limits.requests_per_month).toBeNull();
  });

  it("keeps zero as zero — no allowance stays no allowance at ten branches", () => {
    // Starter cannot send SMS at all. Multiplying nothing must not produce
    // something, and this is the arithmetic half of "null never means zero".
    const scaled = scalePerLocation(PLAN_CATALOG.starter.entitlements, 10);

    expect(scaled.metered.sms_credits).toBe(0);
    expect(scaled.metered.whatsapp_conversations).toBe(0);
  });

  it("floors the count at one, so a brand-new account still has a quota", () => {
    // An organization that has not created a location yet would otherwise
    // resolve to zero of everything and fail its first review request.
    for (const count of [0, -3]) {
      const scaled = scalePerLocation(growth, count);
      expect(scaled.metered.sms_credits, `count ${count}`).toBe(growth.metered.sms_credits);
      expect(scaled.limits.ai_analyses_per_month, `count ${count}`).toBe(
        growth.limits.ai_analyses_per_month,
      );
    }
  });

  it("does not mutate the catalog it was handed", () => {
    // PLAN_CATALOG is module state shared by every caller in the process; a
    // scaler that wrote through it would multiply the same plan forever.
    const before = structuredClone(growth);
    scalePerLocation(growth, 7);
    expect(growth).toEqual(before);
  });
});

describe("resolveEntitlements with a location count", () => {
  it("applies overrides first, then multiplies", () => {
    // An override replaces a plan value, and plan values are per-location
    // figures — so an override is one too. Scaling first would multiply the
    // plan's number and then throw it away.
    const resolved = resolveEntitlements(
      subscription({ planKey: "growth", overrides: { metered: { sms_credits: 40 } } }),
      NOW,
      3,
    );

    expect(resolved.entitlements.metered.sms_credits).toBe(120);
    expect(resolved.locationCount).toBe(3);
  });

  it("scales the fallback plan too, for an organization with no subscription", () => {
    const resolved = resolveEntitlements(null, NOW, 4);

    expect(resolved.effectivePlanKey).toBe(DEFAULT_PLAN_KEY);
    expect(resolved.entitlements.limits.requests_per_month).toBe(
      (PLAN_CATALOG[DEFAULT_PLAN_KEY].entitlements.limits.requests_per_month ?? 0) * 4,
    );
  });

  it("defaults to a single location when no count is given", () => {
    const resolved = resolveEntitlements(subscription({ planKey: "growth" }), NOW);

    expect(resolved.locationCount).toBe(1);
    expect(resolved.entitlements.metered.sms_credits).toBe(
      PLAN_CATALOG.growth.entitlements.metered.sms_credits,
    );
  });
});

describe("currentPeriod", () => {
  it("formats as YYYY-MM in UTC", () => {
    expect(currentPeriod(new Date("2026-08-01T12:00:00Z"))).toBe("2026-08");
    expect(currentPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("does not drift across a month boundary in a non-UTC-friendly instant", () => {
    // 2026-09-01T00:30Z is still August in some local zones; the counter key
    // must be stable regardless of where the server runs.
    expect(currentPeriod(new Date("2026-09-01T00:30:00Z"))).toBe("2026-09");
  });
});
