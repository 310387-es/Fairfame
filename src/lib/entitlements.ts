import { and, count, eq, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import {
  applyOverrides,
  DEFAULT_PLAN_KEY,
  parseEntitlements,
  parseOverrides,
  PLAN_CATALOG,
  TRIAL_PLAN_KEY,
  type Entitlements,
  type FeatureKey,
  type LimitKey,
  type MeteredKey,
  type PlanKey,
} from "./plans.ts";
import { withTenant, type TenantDatabase } from "./tenancy.ts";

/**
 * Entitlements — the single server-side authority on what a plan unlocks.
 *
 * Feature access and limits are read from plan configuration, never from a
 * plan name. There is deliberately no `if (plan === "pro")` anywhere: adding a
 * tier or moving a feature between tiers is an edit to src/lib/plans.ts and a
 * re-seed, not a code change.
 *
 * Resolution is split in two on purpose: `resolveEntitlements()` is pure and
 * exhaustively testable, while the exported `can()` / `withinLimit()` are the
 * thin database shell around it.
 */

export type MetricKey = LimitKey | MeteredKey;

/**
 * Quotas that are **per location**, and are multiplied by how many the
 * organization has (11 Aug 2026 repricing — docs/05 §1–2).
 *
 * Billing is per location, so allowances scale with it: a five-branch Growth
 * account pays five times and gets five times the sends. The catalog stores the
 * single-branch figure, which is what makes the tiers comparable to each other
 * and to a competitor's page.
 *
 * The three absent keys are absent on purpose. `max_locations`,
 * `max_team_members` and `max_widgets` are **absolute** — multiplying a
 * location cap by the location count is a cap that raises itself every time
 * somebody hits it, and would let one branch become unlimited branches.
 */
const PER_LOCATION_KEYS = [
  "requests_per_month",
  "ai_analyses_per_month",
  "sms_credits",
  "whatsapp_conversations",
  "ai_tokens",
] as const satisfies readonly MetricKey[];

/**
 * Scales the per-location quotas by `locationCount`. Pure.
 *
 * - `null` stays `null` — unlimited never multiplies into a number.
 * - `0` stays `0` — a plan that grants no SMS grants none at ten branches.
 * - The count floors at 1, so an organization that has not created a location
 *   yet gets a single branch's quota rather than nothing. Zero would make the
 *   first review request of a new account fail a limit check.
 */
export function scalePerLocation(entitlements: Entitlements, locationCount: number): Entitlements {
  const factor = Math.max(1, Math.trunc(locationCount));
  if (factor === 1) return entitlements;

  const scale = (value: number | null): number | null =>
    value === null || value === 0 ? value : value * factor;

  const limits = { ...entitlements.limits };
  const metered = { ...entitlements.metered };

  for (const key of PER_LOCATION_KEYS) {
    if (key in limits) {
      limits[key as LimitKey] = scale(limits[key as LimitKey]);
    } else {
      metered[key as MeteredKey] = scale(metered[key as MeteredKey]);
    }
  }

  return { features: entitlements.features, limits, metered };
}

/** Subscription facts the resolver needs. Deliberately not the Drizzle row. */
export type SubscriptionSnapshot = {
  planKey: PlanKey;
  status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  currentPeriodEnd: Date | null;
  overrides?: unknown;
};

export type ResolvedEntitlements = {
  entitlements: Entitlements;
  /** Which plan's values were actually applied — useful for UI and audit. */
  effectivePlanKey: PlanKey;
  /** True while a live trial is granting top-tier access. */
  isTrialing: boolean;
  /** When the live trial lapses. Null unless `isTrialing`. */
  trialEndsAt: Date | null;
  /**
   * How many locations the per-location quotas were multiplied by (floored at
   * 1). Returned so a screen can show "1,000 × 3 branches" rather than a total
   * the reader cannot account for.
   */
  locationCount: number;
};

/**
 * Decides which entitlements apply. Pure — no IO, no clock of its own.
 *
 * - A live trial grants top-tier entitlements (docs/03 §7.1).
 * - An expired trial falls to the default plan, never to the trial's tier.
 * - `past_due` keeps the paid plan: dunning is a grace period, not an instant
 *   cutoff. Cancellation is what downgrades.
 * - Anything unusable falls back to the default plan rather than to "no
 *   access", so a billing glitch degrades service instead of bricking it.
 */
export function resolveEntitlements(
  subscription: SubscriptionSnapshot | null,
  now: Date,
  locationCount = 1,
): ResolvedEntitlements {
  const fallback = (): ResolvedEntitlements => ({
    entitlements: PLAN_CATALOG[DEFAULT_PLAN_KEY].entitlements,
    effectivePlanKey: DEFAULT_PLAN_KEY,
    isTrialing: false,
    trialEndsAt: null,
    locationCount,
  });

  if (!subscription) {
    const base = fallback();
    return { ...base, entitlements: scalePerLocation(base.entitlements, locationCount) };
  }

  const overrides = parseOverrides(subscription.overrides);

  /**
   * Overrides first, multiplication second — and the order is load-bearing.
   *
   * An override *replaces* a plan value, and plan values are per-location
   * figures, so an override is one too. Scaling first would multiply the plan's
   * number and then throw it away, making a custom deal silently absolute while
   * every other account scaled.
   */
  const withOverrides = (base: Entitlements): Entitlements =>
    scalePerLocation(applyOverrides(base, overrides), locationCount);

  const periodLive =
    subscription.currentPeriodEnd === null ||
    subscription.currentPeriodEnd.getTime() > now.getTime();

  switch (subscription.status) {
    case "trialing": {
      if (!periodLive) {
        // Expired trial: drop to the floor, not to the trial's tier.
        const base = fallback();
        return { ...base, entitlements: withOverrides(base.entitlements) };
      }
      return {
        entitlements: withOverrides(PLAN_CATALOG[TRIAL_PLAN_KEY].entitlements),
        effectivePlanKey: TRIAL_PLAN_KEY,
        isTrialing: true,
        trialEndsAt: subscription.currentPeriodEnd,
        locationCount,
      };
    }

    case "active":
    case "past_due": {
      return {
        entitlements: withOverrides(PLAN_CATALOG[subscription.planKey].entitlements),
        effectivePlanKey: subscription.planKey,
        isTrialing: false,
        trialEndsAt: null,
        locationCount,
      };
    }

    case "canceled":
    case "incomplete": {
      const base = fallback();
      return { ...base, entitlements: withOverrides(base.entitlements) };
    }
  }
}

// ---------------------------------------------------------------------------
// Database shell
// ---------------------------------------------------------------------------

/**
 * Either an organization id (this opens its own tenant scope) or an id plus an
 * existing tenant transaction to reuse.
 */
export type OrgRef = string | { organizationId: string; tx: TenantDatabase };

function scopeOf(org: OrgRef): { organizationId: string; tx?: TenantDatabase } {
  return typeof org === "string" ? { organizationId: org } : org;
}

/** Runs `fn` in the caller's tenant transaction, or opens one. */
async function inTenant<T>(
  org: OrgRef,
  fn: (tx: TenantDatabase, organizationId: string) => Promise<T>,
): Promise<T> {
  const { organizationId, tx } = scopeOf(org);
  if (tx) return fn(tx, organizationId);
  return withTenant({ organizationId }, (scoped) => fn(scoped, organizationId));
}

/**
 * How many locations the organization has.
 *
 * One definition, read for two different jobs: it is the `max_locations` usage
 * counter *and* the multiplier for every per-location quota. Two counts that
 * could disagree would mean an account allowed to create a branch it does not
 * get any allowance for.
 */
async function countLocations(tx: TenantDatabase, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(schema.locations)
    .where(eq(schema.locations.organizationId, organizationId));
  return row?.value ?? 0;
}

/** Subscription + location count, resolved together. The shell around the pure resolver. */
async function resolveInTx(
  tx: TenantDatabase,
  organizationId: string,
  now: Date,
): Promise<ResolvedEntitlements> {
  const subscription = await loadSubscription(tx, organizationId);
  const locations = await countLocations(tx, organizationId);
  return resolveEntitlements(subscription, now, locations);
}

async function loadSubscription(
  tx: TenantDatabase,
  organizationId: string,
): Promise<SubscriptionSnapshot | null> {
  const [row] = await tx
    .select({
      planKey: schema.plans.key,
      status: schema.subscriptions.status,
      currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
      overrides: schema.subscriptions.overrides,
      entitlements: schema.plans.entitlements,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .where(eq(schema.subscriptions.organizationId, organizationId))
    .orderBy(sql`${schema.subscriptions.createdAt} desc`)
    .limit(1);

  if (!row) return null;

  // The plan row is authoritative for the catalog's shape; validating it here
  // means a hand-edited entitlements blob fails loudly rather than silently
  // granting or denying a feature.
  parseEntitlements(row.entitlements);

  return {
    planKey: row.planKey,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    overrides: row.overrides,
  };
}

export async function getEntitlements(
  org: OrgRef,
  now = new Date(),
): Promise<ResolvedEntitlements> {
  return inTenant(org, async (tx, organizationId) => resolveInTx(tx, organizationId, now));
}

/** Is this feature unlocked for the organization? */
export async function can(org: OrgRef, feature: FeatureKey): Promise<boolean> {
  const { entitlements } = await getEntitlements(org);
  return entitlements.features[feature];
}

export type LimitCheck = {
  allowed: boolean;
  /** Null means unlimited. */
  limit: number | null;
  current: number;
  /** Null when the limit is unlimited. */
  remaining: number | null;
};

/**
 * Resource limits are measured by counting live rows; everything else is
 * measured from `usage_counters` for the current period.
 */
const RESOURCE_COUNTERS: Partial<
  Record<MetricKey, (tx: TenantDatabase, organizationId: string) => Promise<number>>
> = {
  max_locations: countLocations,
  max_team_members: async (tx, organizationId) => {
    const [row] = await tx
      .select({ value: count() })
      .from(schema.memberships)
      .where(eq(schema.memberships.organizationId, organizationId));
    return row?.value ?? 0;
  },
  /**
   * Every widget counts, published or not (P3-T0).
   *
   * Counting only the published ones would make the Starter limit of one mean
   * "one at a time", so a business could keep a drawer of nine and rotate them
   * — and the limit would be enforced against a number that changes when nobody
   * created anything. A widget is a configured resource; owning it is the cost.
   */
  max_widgets: async (tx, organizationId) => {
    const [row] = await tx
      .select({ value: count() })
      .from(schema.widgets)
      .where(eq(schema.widgets.organizationId, organizationId));
    return row?.value ?? 0;
  },
};

/** Billing-period key for usage counters, e.g. "2026-08". */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function limitFor(entitlements: Entitlements, metric: MetricKey): number | null {
  if (metric in entitlements.limits) {
    return entitlements.limits[metric as LimitKey];
  }
  return entitlements.metered[metric as MeteredKey];
}

async function readUsage(
  tx: TenantDatabase,
  organizationId: string,
  metric: MetricKey,
  period: string,
): Promise<number> {
  const resourceCounter = RESOURCE_COUNTERS[metric];
  if (resourceCounter) return resourceCounter(tx, organizationId);

  const [row] = await tx
    .select({ value: schema.usageCounters.count })
    .from(schema.usageCounters)
    .where(
      and(
        eq(schema.usageCounters.organizationId, organizationId),
        eq(schema.usageCounters.metric, metric),
        eq(schema.usageCounters.period, period),
      ),
    )
    .limit(1);

  return row?.value ?? 0;
}

/**
 * Would consuming `additional` units of `metric` stay inside the plan?
 *
 * Defaults to asking about one more unit, which is what a gated action needs:
 * "may I add another location?" rather than "am I currently over?".
 */
export async function withinLimit(
  org: OrgRef,
  metric: MetricKey,
  options: { additional?: number; now?: Date } = {},
): Promise<LimitCheck> {
  const { additional = 1, now = new Date() } = options;

  /**
   * `max_organizations` is a limit on a **user**, not on this organization, and
   * answering it here would be worse than not answering it.
   *
   * There is no resource counter for it, so `readUsage` would fall through to
   * `usage_counters`, find nothing, and return `0` — a check that passes
   * forever while reading exactly like an enforced one. That is the failure
   * mode this codebase keeps finding: not a missing guard but a guard that
   * returns a confident wrong number.
   *
   * `src/auth/organization-limit.ts` owns the question. Throwing rather than
   * returning `allowed: false` because a caller reaching here has the wrong
   * shape, not a refused request, and a refusal would be silently mistaken for
   * enforcement.
   */
  if (metric === "max_organizations") {
    throw new Error(
      "max_organizations is a per-user limit — ask organizationAllowance(userId) in " +
        "src/auth/organization-limit.ts, not withinLimit(org).",
    );
  }

  return inTenant(org, async (tx, organizationId) => {
    const { entitlements } = await resolveInTx(tx, organizationId, now);
    const limit = limitFor(entitlements, metric);
    const current = await readUsage(tx, organizationId, metric, currentPeriod(now));

    if (limit === null) {
      return { allowed: true, limit: null, current, remaining: null };
    }

    return {
      allowed: current + additional <= limit,
      limit,
      current,
      remaining: Math.max(0, limit - current),
    };
  });
}

/**
 * Records consumption of a metered metric for the current period.
 * Upserts, so concurrent callers accumulate rather than overwrite.
 */
export async function recordUsage(
  org: OrgRef,
  metric: MetricKey,
  amount = 1,
  now = new Date(),
): Promise<number> {
  const period = currentPeriod(now);

  return inTenant(org, async (tx, organizationId) => {
    const [row] = await tx
      .insert(schema.usageCounters)
      .values({ organizationId, metric, period, count: amount })
      .onConflictDoUpdate({
        target: [
          schema.usageCounters.organizationId,
          schema.usageCounters.metric,
          schema.usageCounters.period,
        ],
        set: {
          count: sql`${schema.usageCounters.count} + ${amount}`,
          updatedAt: new Date(),
        },
      })
      .returning({ value: schema.usageCounters.count });

    return row?.value ?? 0;
  });
}

export class EntitlementError extends Error {
  // Explicit field, not a parameter property: Node's strip-only type stripping
  // (used by scripts/ and the worker) does not support those.
  readonly key: FeatureKey | MetricKey;

  constructor(message: string, key: FeatureKey | MetricKey) {
    super(message);
    this.name = "EntitlementError";
    this.key = key;
  }
}

/** Throws unless the feature is unlocked. For guarding a server action. */
export async function requireFeature(org: OrgRef, feature: FeatureKey): Promise<void> {
  if (!(await can(org, feature))) {
    throw new EntitlementError(`Feature "${feature}" is not included in this plan.`, feature);
  }
}

/** Throws unless the action fits inside the limit. For guarding a server action. */
export async function requireWithinLimit(
  org: OrgRef,
  metric: MetricKey,
  options: { additional?: number; now?: Date } = {},
): Promise<LimitCheck> {
  const check = await withinLimit(org, metric, options);
  if (!check.allowed) {
    throw new EntitlementError(
      `Limit "${metric}" reached (${check.current}/${check.limit}).`,
      metric,
    );
  }
  return check;
}
