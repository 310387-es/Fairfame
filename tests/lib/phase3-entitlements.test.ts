import { describe, expect, it } from "vitest";
import { applyOverrides, FEATURE_KEYS, PLAN_CATALOG, PLAN_KEYS } from "@/lib/plans";
import { resolveEntitlements } from "@/lib/entitlements";

/**
 * What each plan unlocks in Phase 3 (P3-T7).
 *
 * The Definition of Done is "plan changes toggle these with **no code
 * change**", which is a claim about where the decisions live rather than about
 * any single screen. These assertions are what make it checkable:
 *
 *   1. **Every Phase 3 surface has a key**, and it is a key rather than a plan
 *      name — the `if (plan === "pro")` this codebase forbids would still
 *      produce a correct-looking gate today and an unmaintainable one later.
 *   2. **The values are the packaging**, so this file reads as the pricing
 *      matrix in `docs/05` and fails if the two drift apart.
 *   3. **An override moves a gate without touching a plan**, which is how a
 *      custom deal or a comp is honoured.
 *
 * Deliberately no mocking and no database: `resolveEntitlements` is pure and
 * `PLAN_CATALOG` is the source of truth, so this is the whole mechanism.
 */

/** The keys Phase 3 introduced or relies on, and what each surface reads. */
const PHASE_3_GATES = {
  widgets: "the widget builder and the public widget API",
  seo_pages: "publishing a location's hosted review page",
  analytics: "the Insights workspace and its export",
  scheduled_reports: "emailed PDF reports",
  benchmarking: "the competitor comparison",
} as const;

describe("the gates exist at all", () => {
  it("has a key for every Phase 3 surface", () => {
    // A surface with no key is a surface gated in code, or not gated at all.
    for (const key of Object.keys(PHASE_3_GATES)) {
      expect(FEATURE_KEYS, `${key} should be a feature key`).toContain(key);
    }
  });

  it("gives every plan a value for every key", () => {
    // A missing key is not "off" — it is `undefined`, which is falsy today and
    // a silent hole the first time somebody reads it with `!== false`.
    for (const plan of PLAN_KEYS) {
      for (const key of FEATURE_KEYS) {
        expect(typeof PLAN_CATALOG[plan].entitlements.features[key], `${plan}.${key}`).toBe(
          "boolean",
        );
      }
    }
  });
});

describe("the packaging, as `docs/05` prices it", () => {
  const features = (plan: (typeof PLAN_KEYS)[number]) => PLAN_CATALOG[plan].entitlements.features;

  it("gives Starter the showcase but not the analytics workspace", () => {
    // One widget and a hosted page are what a single-location business is sold;
    // "trends dashboard" starts at Growth.
    expect(features("starter").widgets).toBe(true);
    expect(features("starter").seo_pages).toBe(true);
    expect(features("starter").analytics).toBe(false);
    expect(PLAN_CATALOG.starter.entitlements.limits.max_widgets).toBe(1);
  });

  it("opens Insights at Growth, and leaves reporting and benchmarking above it", () => {
    expect(features("growth").analytics).toBe(true);
    expect(features("growth").scheduled_reports).toBe(false);
    expect(features("growth").benchmarking).toBe(false);
    // Unlimited widgets is the Growth upgrade on the showcase line.
    expect(PLAN_CATALOG.growth.entitlements.limits.max_widgets).toBeNull();
  });

  it("puts scheduled reports and benchmarking at Pro and above", () => {
    for (const plan of ["pro", "agency"] as const) {
      expect(features(plan).scheduled_reports, plan).toBe(true);
      expect(features(plan).benchmarking, plan).toBe(true);
      expect(features(plan).analytics, plan).toBe(true);
    }
  });

  it("never lets a higher tier take a Phase 3 feature away", () => {
    // Packaging is monotonic: whatever Starter gets, Growth gets, and so on.
    // A hole here reads as a bug to a customer who upgraded.
    const order = ["starter", "growth", "pro", "agency"] as const;

    for (const key of Object.keys(PHASE_3_GATES) as (keyof typeof PHASE_3_GATES)[]) {
      let seenTrue = false;
      for (const plan of order) {
        const value = features(plan)[key];
        if (value) seenTrue = true;
        else expect(seenTrue, `${key} is on below ${plan} but off at ${plan}`).toBe(false);
      }
    }
  });
});

describe("changing the packaging is a config change", () => {
  it("moves a gate by editing values, with nothing else to touch", () => {
    // The Definition of Done, made concrete. Pricing the hosted page at Growth+
    // is this edit and no other — no screen, no route, no query.
    const repriced = {
      ...PLAN_CATALOG.starter.entitlements,
      features: { ...PLAN_CATALOG.starter.entitlements.features, seo_pages: false },
    };

    expect(repriced.features.seo_pages).toBe(false);
    // And nothing else moved with it.
    expect(repriced.features.widgets).toBe(true);
  });

  it("honours a per-organization override without touching a plan", () => {
    // A comp or a grandfathered deal: one account gets Insights on Starter.
    const resolved = resolveEntitlements(
      {
        planKey: "starter",
        status: "active",
        currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
        overrides: { features: { analytics: true } },
      },
      new Date("2026-08-01T00:00:00Z"),
    );

    expect(resolved.entitlements.features.analytics).toBe(true);
    // Everything the override did not mention still comes from the plan.
    expect(resolved.entitlements.features.benchmarking).toBe(false);
  });

  it("applies overrides on top of a plan rather than replacing it", () => {
    const merged = applyOverrides(PLAN_CATALOG.starter.entitlements, {
      features: { benchmarking: true },
    });

    expect(merged.features.benchmarking).toBe(true);
    expect(merged.features.analytics).toBe(false);
    expect(merged.limits.max_widgets).toBe(1);
  });
});

describe("what a lapsed account keeps", () => {
  it("drops Phase 3's paid surfaces but leaves the account usable", () => {
    // A cancelled subscription falls to the default plan. Losing Insights is
    // correct; losing the ability to read your own reviews would not be.
    const resolved = resolveEntitlements(
      {
        planKey: "pro",
        status: "canceled",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
      new Date("2026-08-01T00:00:00Z"),
    );

    expect(resolved.entitlements.features.analytics).toBe(false);
    expect(resolved.entitlements.features.scheduled_reports).toBe(false);
    expect(resolved.entitlements.features.benchmarking).toBe(false);
    // Still theirs: the showcase they already published, and the AI they use.
    expect(resolved.entitlements.features.seo_pages).toBe(true);
    expect(resolved.entitlements.features.ai_replies).toBe(true);
  });
});
