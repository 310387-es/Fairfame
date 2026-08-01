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
 */

export const FEATURE_KEYS = [
  "ai_replies",
  "social_sources",
  "competitor_watch",
  "widgets",
  "api_access",
  "white_label",
  "benchmarking",
] as const;

export const LIMIT_KEYS = [
  "max_locations",
  "max_team_members",
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
  /** USD minor units (cents). Null for Agency — quoted per deal. */
  priceMonth: number | null;
  interval: "month" | "year";
  entitlements: Entitlements;
};

export const PLAN_CATALOG: Record<PlanKey, PlanConfig> = {
  starter: {
    key: "starter",
    name: "Starter",
    priceMonth: 2900,
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
      },
      limits: {
        max_locations: 1,
        max_team_members: 2,
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
    priceMonth: 7900,
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
      },
      limits: {
        max_locations: 3,
        max_team_members: 5,
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
    priceMonth: 19900,
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
      },
      limits: {
        max_locations: 10,
        max_team_members: 15,
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
      },
      limits: {
        max_locations: null,
        max_team_members: null,
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
 * Parses an `entitlements` jsonb blob read back from the database.
 * The column is untyped at the DB level, so validate before trusting it.
 */
export function parseEntitlements(value: unknown): Entitlements {
  return entitlementsSchema.parse(value);
}
