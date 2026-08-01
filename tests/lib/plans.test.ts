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
