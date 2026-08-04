import { z } from "zod";

/**
 * Plan catalog — configuration, not code.
 *
 * Entitlement values live here and are seeded into `plans.entitlements`.
 * Changing packaging means editing this file and re-running `pnpm db:seed`;
 * it must never mean writing `if (plan === 'pro')` anywhere in the app.
 *
 * Seed values mirror docs/05-business-model-and-gtm.md §2.1. Numbers there are
 * explicitly "indicative and validated with the first cohort", so treat them as
 * tunable defaults rather than settled product decisions.
 *
 * `null` means unlimited. It never means zero.
 *
 * Pricing is denominated in TRY (kuruş) because Türkiye is the launch market.
 * docs/05 anchors the tiers to ~$29 / ~$79 / ~$199; the TRY figures below apply
 * an assumed ~45 TRY/USD and are explicitly repriced for inflation, exactly as
 * that doc says. Adding USD/EUR plans later means new catalog rows with a
 * different `currency`, not a schema change.
 *
 * `max_widgets` is not in the build plan's key list. Without it the Starter
 * "1 widget" entitlement from docs/05 §2.1 is unexpressible and Starter reads
 * as unlimited widget access, so the key is added here deliberately.
 */

export const FEATURE_KEYS = [
  "ai_replies",
  "social_sources",
  "competitor_watch",
  "widgets",
  "api_access",
  "white_label",
  "benchmarking",
  // Team workflow (P2-T8). Three separate keys rather than one "team" flag,
  // because they are three different reasons to upgrade and packaging will
  // want to move them independently — a solo owner may well be sold SLA
  // tracking without ever needing bulk actions.
  "saved_views",
  "bulk_actions",
  "sla_tracking",
] as const;

export const LIMIT_KEYS = [
  "max_locations",
  "max_team_members",
  "max_widgets",
  "requests_per_month",
  "ai_analyses_per_month",
] as const;

export const METERED_KEYS = ["sms_credits", "whatsapp_conversations", "ai_tokens"] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type MeteredKey = (typeof METERED_KEYS)[number];

/** Unlimited is encoded as null so it survives a JSON round-trip. */
const limitValue = z.number().int().nonnegative().nullable();

export const entitlementsSchema = z.object({
  features: z.object(
    Object.fromEntries(FEATURE_KEYS.map((key) => [key, z.boolean()])) as Record<
      FeatureKey,
      z.ZodBoolean
    >,
  ),
  limits: z.object(
    Object.fromEntries(LIMIT_KEYS.map((key) => [key, limitValue])) as Record<
      LimitKey,
      typeof limitValue
    >,
  ),
  metered: z.object(
    Object.fromEntries(METERED_KEYS.map((key) => [key, limitValue])) as Record<
      MeteredKey,
      typeof limitValue
    >,
  ),
});

export type Entitlements = z.infer<typeof entitlementsSchema>;

export const PLAN_KEYS = ["starter", "growth", "pro", "agency"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export type PlanConfig = {
  key: PlanKey;
  name: string;
  /** Minor units of `currency` (kuruş for TRY). Null for Agency — quoted per deal. */
  priceMonth: number | null;
  /** ISO 4217. TRY is the launch-market currency. */
  currency: string;
  interval: "month" | "year";
  entitlements: Entitlements;
};

export const PLAN_CATALOG: Record<PlanKey, PlanConfig> = {
  starter: {
    key: "starter",
    name: "Starter",
    priceMonth: 129_900, // ₺1.299,00
    currency: "TRY",
    interval: "month",
    entitlements: {
      features: {
        ai_replies: true, // capped — see limits.ai_analyses_per_month
        social_sources: false,
        competitor_watch: false,
        widgets: true, // 1 widget; see the max_widgets note below
        api_access: false,
        white_label: false,
        benchmarking: false,
        // Starter is one location and two seats. Saved views, bulk actions and
        // SLA tracking are what a *team* needs to divide work between people,
        // which is the line this tier sits below.
        saved_views: false,
        bulk_actions: false,
        sla_tracking: false,
      },
      limits: {
        max_locations: 1,
        max_team_members: 2,
        max_widgets: 1,
        requests_per_month: 100,
        ai_analyses_per_month: 250,
      },
      metered: {
        sms_credits: 0,
        whatsapp_conversations: 0,
        ai_tokens: 100_000,
      },
    },
  },
  growth: {
    key: "growth",
    name: "Growth",
    priceMonth: 349_900, // ₺3.499,00
    currency: "TRY",
    interval: "month",
    entitlements: {
      features: {
        ai_replies: true,
        social_sources: true,
        competitor_watch: false,
        widgets: true,
        api_access: false,
        white_label: false,
        benchmarking: false,
        saved_views: true,
        bulk_actions: true,
        sla_tracking: true,
      },
      limits: {
        max_locations: 3,
        max_team_members: 5,
        max_widgets: null, // unlimited
        requests_per_month: null, // unlimited (fair use)
        ai_analyses_per_month: 2_000,
      },
      metered: {
        sms_credits: 250,
        whatsapp_conversations: 250,
        ai_tokens: 1_000_000,
      },
    },
  },
  pro: {
    key: "pro",
    name: "Pro",
    priceMonth: 899_900, // ₺8.999,00
    currency: "TRY",
    interval: "month",
    entitlements: {
      features: {
        ai_replies: true,
        social_sources: true,
        competitor_watch: true,
        widgets: true,
        api_access: true,
        white_label: false,
        benchmarking: true,
        saved_views: true,
        bulk_actions: true,
        sla_tracking: true,
      },
      limits: {
        max_locations: 10,
        max_team_members: 15,
        max_widgets: null,
        requests_per_month: null,
        ai_analyses_per_month: 10_000,
      },
      metered: {
        sms_credits: 1_000,
        whatsapp_conversations: 1_000,
        ai_tokens: 5_000_000,
      },
    },
  },
  agency: {
    key: "agency",
    name: "Agency",
    priceMonth: null, // custom: per-seat + per-location
    currency: "TRY",
    interval: "month",
    entitlements: {
      features: {
        ai_replies: true,
        social_sources: true,
        competitor_watch: true,
        widgets: true,
        api_access: true,
        white_label: true,
        benchmarking: true,
        saved_views: true,
        bulk_actions: true,
        sla_tracking: true,
      },
      limits: {
        max_locations: null,
        max_team_members: null,
        max_widgets: null,
        requests_per_month: null,
        ai_analyses_per_month: null,
      },
      metered: {
        sms_credits: 2_500,
        whatsapp_conversations: 2_500,
        ai_tokens: 20_000_000,
      },
    },
  },
};

/** The 14-day trial grants top-tier entitlements (docs/03 §7.1). */
export const TRIAL_PLAN_KEY: PlanKey = "agency";
export const TRIAL_DAYS = 14;

/**
 * The floor an organization lands on when it has no usable subscription — a
 * lapsed trial, a cancelled plan, or (defensively) no subscription row at all.
 * Never leave an organization on top-tier entitlements by accident.
 */
export const DEFAULT_PLAN_KEY: PlanKey = "starter";

/**
 * Per-organization entitlement overrides stored on `subscriptions.overrides`:
 * custom deals, comps, grandfathered packaging. Every section is partial, and
 * anything absent falls through to the plan.
 */
export const entitlementOverridesSchema = z
  .object({
    features: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()),
    limits: z.partialRecord(z.enum(LIMIT_KEYS), limitValue),
    metered: z.partialRecord(z.enum(METERED_KEYS), limitValue),
  })
  .partial();

export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;

/** Tolerant parse: a malformed overrides blob must not take the app down. */
export function parseOverrides(value: unknown): EntitlementOverrides {
  const result = entitlementOverridesSchema.safeParse(value ?? {});
  return result.success ? result.data : {};
}

/** Applies overrides on top of a plan's entitlements. Pure. */
export function applyOverrides(base: Entitlements, overrides: EntitlementOverrides): Entitlements {
  return {
    features: { ...base.features, ...overrides.features },
    limits: { ...base.limits, ...overrides.limits },
    metered: { ...base.metered, ...overrides.metered },
  };
}

/**
 * Parses an `entitlements` jsonb blob read back from the database.
 * The column is untyped at the DB level, so validate before trusting it.
 */
export function parseEntitlements(value: unknown): Entitlements {
  return entitlementsSchema.parse(value);
}
