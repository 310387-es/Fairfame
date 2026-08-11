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
 * **The catalog is USD-only (cents), decided 11 Aug 2026 — docs/05 §1–2.** It
 * was TRY, on the argument that Türkiye is the launch market. That is a fact
 * about where the first customers are rather than about the product, and it
 * bought a second price list to reprice against inflation on a schedule nobody
 * owns. The payment provider converts at charge time instead: Stripe presents
 * local currency where it can, iyzico charges the TRY equivalent with e-fatura
 * when that adapter goes live. `currency` stays on every row because formatters
 * read it — one value in it today is not the same as no value.
 *
 * **Price is base + extras, not a cap.** Each tier includes N locations
 * (`includedLocations`) and prices the rest (`priceExtraLocationMonth`);
 * `limits.max_locations` survives as the hard ceiling of the tier rather than
 * as the thing being sold. Annual is 10× monthly — two months free.
 *
 * **Quotas below are per location, not per organization.** `requests_per_month`,
 * `ai_analyses_per_month` and all three metered keys are multiplied by the
 * organization's location count before any comparison; see
 * `scalePerLocation` in src/lib/entitlements.ts. The numbers here are therefore
 * what *one* branch gets, which is what makes them comparable across tiers.
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
  // Scheduled PDF/email reports (P3-T5). Pro and above, per the feature matrix
  // in `docs/05` — per-location reporting is what that tier is sold on.
  "scheduled_reports",
  /**
   * The Insights workspace (P3-T7).
   *
   * `docs/05` lists "trends dashboard" from Growth, and this is that dashboard.
   * Starter still gets Home, which answers "what needs doing today" for one
   * branch — the thing a one-location business actually opens daily. Insights
   * answers "what is happening to us across branches", which is the question
   * that starts mattering at the tier where there are branches.
   */
  "analytics",
  /**
   * Hosted public review pages (P3-T7).
   *
   * **Its own key, deliberately set to match today's behaviour rather than to
   * change it.** `docs/05` prices widgets and the hosted page as one line
   * ("Widgets / showcase"), so it is on for every tier — but P3-T7's whole
   * point is that a packaging change must be a config edit, and while the two
   * shared a key it could not be. Moving the page to Growth+ is now one `false`
   * here and nothing else. That is a pricing decision, not a technical one.
   */
  "seo_pages",
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
  /**
   * Contact profiles, the timeline and segments (P4-T1).
   *
   * `docs/05` has no line for this — it was written before Phase 4 existed — so
   * the packaging comes from `docs/20` P4-T6, which puts "messaging + surveys +
   * CRM" at Growth and above. Starter is one location and two seats; the thing
   * it is sold is the review loop, and a customer database is what starts
   * mattering when there is somebody whose job is to work it.
   *
   * Deliberately one key covering the profiles, the timeline and the segments
   * together: they are not three purchases, and a plan that granted the list
   * without the history would be selling a spreadsheet.
   */
  "crm",
  /**
   * NPS / CSAT surveys (P4-T2).
   *
   * Growth and above, from the same `docs/20` P4-T6 line as `crm`. Its own key
   * rather than sharing that one: a business may well want a customer file
   * without running surveys, and the point of a key is that moving one is a
   * config edit. The Insights survey card is gated on **both** this and
   * `analytics` — a panel that answered when the workspace around it would not
   * is a way to read a paid feature by URL.
   */
  "surveys",
  /**
   * Two-way messaging with customers (P4-T3).
   *
   * Growth and above, the third key from `docs/20` P4-T6's "messaging +
   * surveys + CRM" line. Its own key for the same reason the other two have
   * theirs: a business may want a customer file and surveys without running a
   * WhatsApp inbox, and moving one of the three must be a config edit.
   *
   * It gates the *screen and the send*, not the **inbound webhook**. A message
   * a customer has already sent must still be recorded and must still be able
   * to opt them out, whatever the plan says — dropping an inbound "STOP"
   * because a subscription lapsed would be the worst possible way to save
   * money.
   */
  "messaging",
  /**
   * Unified outbound broadcasts (P4-T4).
   *
   * Growth and above. `docs/20` P4-T6 lists "campaigns" on its own line, apart
   * from the messaging/surveys/CRM group, and the split is real: a business can
   * want a customer file and a survey without ever scheduling a send to five
   * hundred people. The thing this gates is *scale* — which is also the thing
   * that costs money and the thing a consent mistake multiplies.
   */
  "broadcasts",
  /**
   * The agency console — `/agency` (P4-T6).
   *
   * **Agency tier, because `docs/20` P4-T6 says so**, and this reverses my own
   * first judgement. T5 shipped it ungated on the argument that a roster is
   * bookkeeping over access somebody already has, so there is nothing to sell.
   * That argument is not wrong, but it is an argument about *this* screen, and
   * the plan prices "white-label + agency console" together as the thing an
   * agency buys. A build plan that says which tier a feature is on is a pricing
   * decision already taken.
   *
   * **The organization switcher is deliberately *not* behind this.** Being able
   * to leave an organization you are a member of is not a feature; a person
   * stranded in a client account because somebody downgraded is a support
   * ticket, not an upsell.
   */
  "agency_console",
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
  /** Minor units of `currency` (USD cents). Null for Agency — quoted per deal. */
  priceMonth: number | null;
  /** Annual price in minor units: 10× monthly, so two months are free. Null = no annual option. */
  priceYear: number | null;
  /** ISO 4217. USD-only catalog; the provider converts at charge time. */
  currency: string;
  interval: "month" | "year";
  /** Locations included in the base price. Not the ceiling — that is `limits.max_locations`. */
  includedLocations: number;
  /** Minor units per extra location per month. Null = not purchasable, or per deal. */
  priceExtraLocationMonth: number | null;
  /** Minor units per extra location per year. */
  priceExtraLocationYear: number | null;
  entitlements: Entitlements;
};

export const PLAN_CATALOG: Record<PlanKey, PlanConfig> = {
  starter: {
    key: "starter",
    name: "Starter",
    priceMonth: 2_900, // $29.00
    priceYear: 29_000, // $290.00 — two months free
    currency: "USD",
    interval: "month",
    includedLocations: 1,
    // Extras are not purchasable on Starter: it is the single-location plan,
    // and a second branch is the upgrade rather than an add-on line.
    priceExtraLocationMonth: null,
    priceExtraLocationYear: null,
    entitlements: {
      features: {
        ai_replies: true, // capped — see limits.ai_analyses_per_month
        social_sources: false,
        competitor_watch: false,
        widgets: true, // 1 widget; see the max_widgets note below
        scheduled_reports: false,
        // Home, not Insights. See the key's note.
        analytics: false,
        seo_pages: true,
        api_access: false,
        white_label: false,
        benchmarking: false,
        // Saved views and bulk actions are what a *team* needs to divide work
        // between people, and Starter is one location and two seats.
        saved_views: false,
        bulk_actions: false,
        // SLA tracking is not on that line. "You promised to reply in 24 hours
        // and haven't" is about the customer, not about coordinating
        // colleagues — and a one-location shop is exactly who forgets. Holding
        // it back would withhold the thing that demonstrates the product works
        // from the tier most likely to need convincing.
        sla_tracking: true,
        crm: false,
        surveys: false,
        messaging: false,
        broadcasts: false,
        agency_console: false,
      },
      limits: {
        max_locations: 1,
        max_team_members: 3,
        max_widgets: 1,
        requests_per_month: 100,
        ai_analyses_per_month: 300,
      },
      metered: {
        // Zero, not null. A Starter account may not send SMS or WhatsApp at
        // all, and null here would read as unlimited — the one confusion this
        // file's "null never means zero" rule exists to prevent.
        sms_credits: 0,
        whatsapp_conversations: 0,
        ai_tokens: 200_000,
      },
    },
  },
  growth: {
    key: "growth",
    name: "Growth",
    priceMonth: 8_900, // $89.00
    priceYear: 89_000, // $890.00 — two months free
    currency: "USD",
    interval: "month",
    includedLocations: 1,
    priceExtraLocationMonth: 4_900, // $49.00
    priceExtraLocationYear: 49_000, // $490.00
    entitlements: {
      features: {
        ai_replies: true,
        social_sources: true,
        competitor_watch: false,
        widgets: true,
        /**
         * Moved down from Pro (11 Aug 2026, docs/05 §2.1).
         *
         * The weekly rhythm is the retention engine — a report that arrives
         * every Monday is what keeps an account opening the product — so
         * charging Pro money for it withheld the habit from the tier that most
         * needs forming one. Pro's upgrade case stands on benchmarking,
         * competitor watch and the API instead, which are all things a
         * multi-location operator asks for by name.
         */
        scheduled_reports: true,
        analytics: true,
        seo_pages: true,
        api_access: false,
        white_label: false,
        benchmarking: false,
        saved_views: true,
        bulk_actions: true,
        sla_tracking: true,
        crm: true,
        surveys: true,
        messaging: true,
        broadcasts: true,
        agency_console: false,
      },
      limits: {
        max_locations: 5,
        max_team_members: 10,
        max_widgets: null, // unlimited
        requests_per_month: null, // unlimited (fair use)
        ai_analyses_per_month: 1_000, // per location
      },
      metered: {
        // Per location. WhatsApp runs ~2.5× SMS deliberately: it is the
        // cheaper channel and the one Turkish customers actually read, so the
        // ratio steers volume toward the send that protects margin. Keep it if
        // these numbers move.
        sms_credits: 100,
        whatsapp_conversations: 250,
        ai_tokens: 1_000_000,
      },
    },
  },
  pro: {
    key: "pro",
    name: "Pro",
    priceMonth: 22_900, // $229.00
    priceYear: 229_000, // $2,290.00 — two months free
    currency: "USD",
    interval: "month",
    includedLocations: 3,
    priceExtraLocationMonth: 5_900, // $59.00
    priceExtraLocationYear: 59_000, // $590.00
    entitlements: {
      features: {
        ai_replies: true,
        social_sources: true,
        competitor_watch: true,
        widgets: true,
        scheduled_reports: true,
        analytics: true,
        seo_pages: true,
        api_access: true,
        white_label: false,
        benchmarking: true,
        saved_views: true,
        bulk_actions: true,
        sla_tracking: true,
        crm: true,
        surveys: true,
        messaging: true,
        broadcasts: true,
        agency_console: false,
      },
      limits: {
        max_locations: 25,
        // Unlimited from Pro, which is the category norm: a multi-location
        // operator counting seats is a customer being taught to ration access
        // to their own reviews.
        max_team_members: null,
        max_widgets: null,
        requests_per_month: null,
        ai_analyses_per_month: 2_500, // per location
      },
      metered: {
        // Per location, keeping the ~2.5× WhatsApp:SMS ratio — see Growth.
        sms_credits: 250,
        whatsapp_conversations: 500,
        ai_tokens: 2_000_000,
      },
    },
  },
  agency: {
    key: "agency",
    name: "Agency",
    /**
     * Quoted per deal, so there is no list price — but the anchor is real and
     * worth writing down: **from $299/mo including 10 client locations, then
     * +$29/location wholesale**, with volume discounts from roughly 25. Null
     * here rather than 29_900 because the screen must say "talk to us" instead
     * of quoting a number sales will not honour.
     */
    priceMonth: null,
    priceYear: null,
    currency: "USD",
    interval: "month",
    includedLocations: 10,
    priceExtraLocationMonth: 2_900, // $29.00 wholesale
    priceExtraLocationYear: 29_000, // $290.00
    entitlements: {
      features: {
        ai_replies: true,
        social_sources: true,
        competitor_watch: true,
        widgets: true,
        scheduled_reports: true,
        analytics: true,
        seo_pages: true,
        api_access: true,
        white_label: true,
        benchmarking: true,
        saved_views: true,
        bulk_actions: true,
        sla_tracking: true,
        crm: true,
        surveys: true,
        messaging: true,
        broadcasts: true,
        agency_console: true,
      },
      limits: {
        max_locations: null,
        max_team_members: null,
        max_widgets: null,
        requests_per_month: null,
        ai_analyses_per_month: null,
      },
      /**
       * **Unresolved: docs/05 calls these "pooled", and the resolver multiplies
       * them like every other tier's.**
       *
       * §2.1's table reads "2,500 / 2,500 pooled" — one allowance for the whole
       * agency. The per-location rule in `scalePerLocation` has no plan
       * exception, deliberately: a `planKey === "agency"` branch is exactly the
       * hardcoding CLAUDE.md forbids, and `subscriptions.overrides` cannot
       * express "pooled" either, because an override is multiplied too.
       *
       * So an agency with 40 client locations resolves to 100,000 SMS credits
       * rather than 2,500. Left as the uniform rule rather than guessed at,
       * because the fix is a packaging decision: either these numbers become
       * genuine per-location figures (2,500 ÷ 10 = 250 each, matching Pro), or
       * the catalog needs a `meteredPooled` flag and the resolver a second
       * branch. Flagged in docs/23 and raised with the decision's owner.
       */
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
