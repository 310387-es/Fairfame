import { describe, expect, it } from "vitest";
import {
  entitlementsSchema,
  FEATURE_KEYS,
  LIMIT_KEYS,
  METERED_KEYS,
  parseEntitlements,
  PLAN_CATALOG,
  PLAN_KEYS,
  TRIAL_PLAN_KEY,
  type PlanKey,
} from "@/lib/plans";

/** Unlimited (null) ranks above every finite allowance. */
function rank(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

/** Ascending tiers — each must be a superset of the one before it. */
const ASCENDING_TIERS: PlanKey[] = ["starter", "growth", "pro", "agency"];

describe("plan catalog", () => {
  it("covers exactly the four seeded plan keys", () => {
    expect([...PLAN_KEYS]).toEqual(["starter", "growth", "pro", "agency"]);
    expect(Object.keys(PLAN_CATALOG).sort()).toEqual([...PLAN_KEYS].sort());
  });

  it.each(PLAN_KEYS)("%s entitlements satisfy the schema", (key) => {
    expect(() => entitlementsSchema.parse(PLAN_CATALOG[key].entitlements)).not.toThrow();
  });

  it.each(PLAN_KEYS)("%s declares every entitlement key — no silent gaps", (key) => {
    const { features, limits, metered } = PLAN_CATALOG[key].entitlements;

    // A missing key must never be readable as "false"/"0" by accident; the
    // catalog is the contract that can()/withinLimit() reads in T6.
    expect(Object.keys(features).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(Object.keys(limits).sort()).toEqual([...LIMIT_KEYS].sort());
    expect(Object.keys(metered).sort()).toEqual([...METERED_KEYS].sort());
  });

  it("never loses a feature as the tier goes up", () => {
    for (let i = 1; i < ASCENDING_TIERS.length; i += 1) {
      const lower = PLAN_CATALOG[ASCENDING_TIERS[i - 1] as PlanKey].entitlements.features;
      const higher = PLAN_CATALOG[ASCENDING_TIERS[i] as PlanKey].entitlements.features;

      for (const feature of FEATURE_KEYS) {
        if (lower[feature]) {
          expect(
            higher[feature],
            `${ASCENDING_TIERS[i]} must keep "${feature}" granted by ${ASCENDING_TIERS[i - 1]}`,
          ).toBe(true);
        }
      }
    }
  });

  it("never lowers a limit or allowance as the tier goes up", () => {
    for (let i = 1; i < ASCENDING_TIERS.length; i += 1) {
      const lower = PLAN_CATALOG[ASCENDING_TIERS[i - 1] as PlanKey].entitlements;
      const higher = PLAN_CATALOG[ASCENDING_TIERS[i] as PlanKey].entitlements;

      for (const limit of LIMIT_KEYS) {
        expect(
          rank(higher.limits[limit]),
          `${ASCENDING_TIERS[i]}.${limit} must be >= ${ASCENDING_TIERS[i - 1]}`,
        ).toBeGreaterThanOrEqual(rank(lower.limits[limit]));
      }

      for (const metric of METERED_KEYS) {
        expect(
          rank(higher.metered[metric]),
          `${ASCENDING_TIERS[i]}.${metric} must be >= ${ASCENDING_TIERS[i - 1]}`,
        ).toBeGreaterThanOrEqual(rank(lower.metered[metric]));
      }
    }
  });

  it("gates the paid-only features off on Starter", () => {
    const starter = PLAN_CATALOG.starter.entitlements.features;

    expect(starter.social_sources).toBe(false);
    expect(starter.competitor_watch).toBe(false);
    expect(starter.api_access).toBe(false);
    expect(starter.benchmarking).toBe(false);
    expect(starter.white_label).toBe(false);
  });

  it("gives Starter SLA tracking, which is about the customer rather than the team", () => {
    // Saved views and bulk actions divide work between colleagues, and Starter
    // is one location and two seats. A response deadline is not that: "you
    // promised to reply in 24 hours and haven't" is about the person waiting,
    // and the smallest business is the one most likely to let it slip.
    const starter = PLAN_CATALOG.starter.entitlements.features;

    expect(starter.sla_tracking).toBe(true);
    expect(starter.saved_views).toBe(false);
    expect(starter.bulk_actions).toBe(false);
  });

  it("reserves white-label for Agency alone", () => {
    const withWhiteLabel = PLAN_KEYS.filter(
      (key) => PLAN_CATALOG[key].entitlements.features.white_label,
    );
    expect(withWhiteLabel).toEqual(["agency"]);
  });

  it("grants top-tier entitlements to the trial", () => {
    const trial = PLAN_CATALOG[TRIAL_PLAN_KEY].entitlements;
    expect(Object.values(trial.features).every(Boolean)).toBe(true);
  });

  it("prices ascend, with Agency quoted per deal", () => {
    expect(PLAN_CATALOG.starter.priceMonth).toBeLessThan(PLAN_CATALOG.growth.priceMonth ?? 0);
    expect(PLAN_CATALOG.growth.priceMonth).toBeLessThan(PLAN_CATALOG.pro.priceMonth ?? 0);
    expect(PLAN_CATALOG.agency.priceMonth).toBeNull();
  });

  it("prices one catalog in USD, in whole minor units", () => {
    // One currency, decided 11 Aug 2026 (docs/05 §1): the provider converts at
    // charge time rather than us keeping a TRY list to reprice for inflation.
    for (const key of PLAN_KEYS) {
      const plan = PLAN_CATALOG[key];
      expect(plan.currency, `${key} should be priced in the catalog currency`).toBe("USD");
      if (plan.priceMonth !== null) {
        expect(Number.isInteger(plan.priceMonth), `${key} price must be integer cents`).toBe(true);
      }
      if (plan.priceYear !== null) {
        expect(Number.isInteger(plan.priceYear), `${key} annual price must be integer cents`).toBe(
          true,
        );
      }
    }
  });

  it("gives two months free on annual, on every tier that has one", () => {
    // The discount is the offer, so it is pinned rather than left to a comment:
    // a tier repriced monthly and not annually would quietly become 12x.
    for (const key of PLAN_KEYS) {
      const { priceMonth, priceYear } = PLAN_CATALOG[key];
      if (priceMonth === null || priceYear === null) continue;
      expect(priceYear, `${key} annual should be 10x monthly`).toBe(priceMonth * 10);
    }
  });

  it("includes locations in the base price, at or below the tier's ceiling", () => {
    // `includedLocations` is what you get; `max_locations` is the ceiling. A
    // plan that included more than it allowed would sell what it then refuses.
    for (const key of PLAN_KEYS) {
      const plan = PLAN_CATALOG[key];
      expect(plan.includedLocations, `${key} must include at least one location`).toBeGreaterThan(
        0,
      );
      const ceiling = plan.entitlements.limits.max_locations;
      if (ceiling !== null) {
        expect(plan.includedLocations, `${key} includes more than it allows`).toBeLessThanOrEqual(
          ceiling,
        );
      }
    }
  });

  it("caps widgets on Starter so the flag alone cannot imply unlimited", () => {
    // The `widgets` boolean is true on every tier; only the limit distinguishes
    // Starter's single widget from the higher tiers.
    expect(PLAN_CATALOG.starter.entitlements.limits.max_widgets).toBe(1);
    expect(PLAN_CATALOG.growth.entitlements.limits.max_widgets).toBeNull();
  });

  it("rejects an entitlements blob with a missing key", () => {
    const { social_sources: _dropped, ...features } = PLAN_CATALOG.pro.entitlements.features;
    const broken = { ...PLAN_CATALOG.pro.entitlements, features };

    expect(() => parseEntitlements(broken)).toThrow();
  });

  it("rejects a negative allowance", () => {
    const broken = {
      ...PLAN_CATALOG.pro.entitlements,
      limits: { ...PLAN_CATALOG.pro.entitlements.limits, max_locations: -1 },
    };

    expect(() => parseEntitlements(broken)).toThrow();
  });
});
