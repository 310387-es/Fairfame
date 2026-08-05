import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  entitlementsSchema,
  FEATURE_KEYS,
  PLAN_CATALOG,
  PLAN_KEYS,
  parseOverrides,
  type FeatureKey,
  type PlanKey,
} from "@/lib/plans";
import { resolveEntitlements } from "@/lib/entitlements";

/**
 * Phase 4 entitlements (P4-T6).
 *
 * The Definition of Done is "plan changes toggle engagement features with no
 * code change", which is a claim about the *shape* of the code rather than
 * about any one value. So this file asserts the shape: every Phase 4 surface
 * has a key, every plan has a value for every key, the values read as
 * `docs/20` prices them, packaging is monotonic, and an override moves a gate
 * without touching a plan.
 *
 * Modelled on `tests/lib/phase3-entitlements.test.ts`, which exists for the
 * same reason: without it, "gated per plan config" is a sentence in a build
 * plan rather than something anybody can check.
 */

/**
 * Every Phase 4 surface, and the key that gates it.
 *
 * The list is the point. A surface added later with no key would have to be
 * added here to be noticed — and a key with no surface is dead packaging.
 */
const SURFACES: Record<string, FeatureKey> = {
  "/contacts — profiles, timeline, segments (T1)": "crm",
  "/surveys — NPS and CSAT, and the send (T2)": "surveys",
  "/messages — conversations and outbound (T3)": "messaging",
  "/broadcasts — scheduled sends to a segment (T4)": "broadcasts",
  "/clients — the agency console (T5)": "agency_console",
  "settings › branding — removing our mark, custom domain (T5)": "white_label",
};

const PHASE_4_KEYS = [...new Set(Object.values(SURFACES))];

function features(plan: PlanKey) {
  return PLAN_CATALOG[plan].entitlements.features;
}

describe("the gates exist at all", () => {
  it("has a key for every Phase 4 surface", () => {
    for (const [surface, key] of Object.entries(SURFACES)) {
      expect(FEATURE_KEYS, `${surface} is gated on an unknown key`).toContain(key);
    }
  });

  it("gives every plan a value for every key", () => {
    // A missing key is not "off" — `parseEntitlements` throws on it, and the
    // first thing anybody would notice is a 500 on an unrelated screen.
    for (const plan of PLAN_KEYS) {
      const parsed = entitlementsSchema.safeParse(PLAN_CATALOG[plan].entitlements);
      expect(parsed.success, `${plan} has an incomplete entitlements block`).toBe(true);

      for (const key of PHASE_4_KEYS) {
        expect(typeof features(plan)[key], `${plan}.${key}`).toBe("boolean");
      }
    }
  });
});

describe("the packaging, as `docs/20` P4-T6 prices it", () => {
  it("gives Starter none of the engagement features", () => {
    // Starter is one location and two seats: the review loop, not a customer
    // database with a messaging inbox attached.
    for (const key of ["crm", "surveys", "messaging", "broadcasts"] as const) {
      expect(features("starter")[key], `starter.${key}`).toBe(false);
    }
  });

  it("opens messaging, surveys and the CRM at Growth", () => {
    // "messaging + surveys + CRM (Growth/Pro)".
    for (const key of ["crm", "surveys", "messaging"] as const) {
      expect(features("growth")[key], `growth.${key}`).toBe(true);
      expect(features("pro")[key], `pro.${key}`).toBe(true);
    }
  });

  it("opens broadcasts at Growth too", () => {
    /**
     * `docs/20` reads "messaging + surveys + CRM (Growth/Pro), campaigns,
     * white-label + agency console (Agency tier)" — the parentheticals attach
     * to the first and last groups, leaving campaigns between them without one.
     * Grouped with the first, because it is plainly not inside the Agency
     * parenthetical.
     *
     * **This is the one open pricing question in Phase 4**, and it is a
     * business decision rather than a technical one: a broadcast is the *scale*
     * feature, which is an argument for Pro. Moving it is one `false` here.
     */
    expect(features("growth").broadcasts).toBe(true);
  });

  it("keeps white-label and the agency console to the Agency tier", () => {
    for (const key of ["white_label", "agency_console"] as const) {
      expect(features("starter")[key], `starter.${key}`).toBe(false);
      expect(features("growth")[key], `growth.${key}`).toBe(false);
      expect(features("pro")[key], `pro.${key}`).toBe(false);
      expect(features("agency")[key], `agency.${key}`).toBe(true);
    }
  });

  it("never lets a higher tier take a Phase 4 feature away", () => {
    // Monotonicity. An upgrade that removed something is the kind of packaging
    // bug nobody finds until a customer does, and it is invisible in a matrix
    // read one column at a time.
    const ladder: PlanKey[] = ["starter", "growth", "pro", "agency"];

    for (let step = 1; step < ladder.length; step += 1) {
      const lower = features(ladder[step - 1]!);
      const higher = features(ladder[step]!);

      for (const key of PHASE_4_KEYS) {
        if (lower[key]) {
          expect(higher[key], `${ladder[step]} lost ${key} that ${ladder[step - 1]} had`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe("changing the packaging is a config change", () => {
  it("moves a gate by editing values, with nothing else to touch", () => {
    // The DoD, literally: the resolver reads the catalog, so a different value
    // is a different answer and no call site changes.
    const asShipped = resolveEntitlements(
      { planKey: "growth", status: "active", currentPeriodEnd: null },
      new Date(),
    );
    expect(asShipped.entitlements.features.broadcasts).toBe(true);

    const repriced = applyOverrides(PLAN_CATALOG.growth.entitlements, {
      features: { broadcasts: false },
    });
    expect(repriced.features.broadcasts).toBe(false);
    // …and nothing else moved.
    expect(repriced.features.crm).toBe(true);
  });

  it("honours a per-organization override without touching a plan", () => {
    // A comp, a custom deal, a grandfathered account.
    const resolved = resolveEntitlements(
      {
        planKey: "starter",
        status: "active",
        currentPeriodEnd: null,
        overrides: { features: { crm: true, messaging: true } },
      },
      new Date(),
    );

    expect(resolved.entitlements.features.crm).toBe(true);
    expect(resolved.entitlements.features.messaging).toBe(true);
    // The plan itself is untouched for everybody else.
    expect(features("starter").crm).toBe(false);
  });

  it("ignores a malformed overrides blob rather than granting everything", () => {
    // Tolerant parsing must fail *closed*: a corrupt blob is no override, not
    // an open door.
    expect(parseOverrides("nonsense")).toEqual({});
    expect(parseOverrides({ features: { crm: "yes" } })).toEqual({});
  });
});

describe("what a lapsed account keeps", () => {
  it("drops Phase 4's paid surfaces", () => {
    const resolved = resolveEntitlements(
      { planKey: "agency", status: "canceled", currentPeriodEnd: new Date("2026-01-01") },
      new Date("2026-08-05"),
    );

    for (const key of PHASE_4_KEYS) {
      expect(resolved.entitlements.features[key], `cancelled kept ${key}`).toBe(false);
    }
  });

  it("leaves what a customer already published alone", () => {
    /**
     * The P3-T7 rule, restated because Phase 4 makes it matter more. Cancelling
     * closes dashboards; it does not reach out and darken something a
     * customer's customers can already see. `seo_pages` survives, and the
     * public survey page has **no entitlement check at all** for the same
     * reason — a QR code on a café table cannot be un-printed, and answering it
     * must not start failing because a card expired.
     */
    const resolved = resolveEntitlements(
      { planKey: "agency", status: "canceled", currentPeriodEnd: new Date("2026-01-01") },
      new Date("2026-08-05"),
    );

    expect(resolved.entitlements.features.seo_pages).toBe(true);
    expect(resolved.entitlements.features.widgets).toBe(true);
  });

  it("keeps a past-due account working, because dunning is a grace period", () => {
    const resolved = resolveEntitlements(
      { planKey: "growth", status: "past_due", currentPeriodEnd: null },
      new Date(),
    );

    expect(resolved.entitlements.features.crm).toBe(true);
    expect(resolved.entitlements.features.messaging).toBe(true);
  });
});
