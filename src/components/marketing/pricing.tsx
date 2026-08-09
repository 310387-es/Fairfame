import { getFormatter, getTranslations } from "next-intl/server";
import { getLocale } from "@/i18n/locale";
import { PLAN_CATALOG, PLAN_KEYS, type PlanKey } from "@/lib/plans";

/**
 * The pricing table, derived from the plan catalogue rather than written out.
 *
 * **What each tier "adds" is computed, not typed.** `PLAN_CATALOG` is the thing
 * the application actually enforces, so a hand-written list here could promise
 * a feature the product would then refuse — the failure a customer discovers
 * after paying. Diffing consecutive tiers means the page is wrong only if the
 * product is wrong, and moving a feature between plans (which `docs/05` says is
 * one `false` in `plans.ts` and nothing else) updates this page for free.
 *
 * Four columns divided by hairlines rather than four floating cards: this page
 * is a document, and a spec table is what a document uses to compare things.
 * No "most popular" flag — we have no customers yet, so it would be invented.
 */
const MAX_FEATURES_SHOWN = 4;

/** Feature keys this tier turns on that the tier below it does not have. */
function addedFeatures(plan: PlanKey, index: number): string[] {
  const features = PLAN_CATALOG[plan].entitlements.features as Record<string, boolean>;
  const below = index === 0 ? null : PLAN_CATALOG[PLAN_KEYS[index - 1]!].entitlements.features;
  const previous = (below ?? {}) as Record<string, boolean>;

  return Object.keys(features).filter((key) => features[key] && !previous[key]);
}

export async function Pricing() {
  const locale = await getLocale();
  const [t, format] = await Promise.all([
    getTranslations({ locale, namespace: "marketing" }),
    getFormatter({ locale }),
  ]);

  const forLabel: Record<PlanKey, string> = {
    starter: t("planStarterFor"),
    growth: t("planGrowthFor"),
    pro: t("planProFor"),
    agency: t("planAgencyFor"),
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card">
      <div className="grid divide-y divide-line-inner lg:grid-cols-4 lg:divide-x lg:divide-y-0">
        {PLAN_KEYS.map((key, index) => {
          const plan = PLAN_CATALOG[key];
          const added = addedFeatures(key, index);
          const shown = added.slice(0, MAX_FEATURES_SHOWN);
          const hidden = added.length - shown.length;

          return (
            <div key={key} className="flex flex-col gap-4 p-6">
              <div>
                <h3 className="text-title">{plan.name}</h3>
                <p className="mt-0.5 text-copy text-muted-foreground">{forLabel[key]}</p>
              </div>

              {/*
                Minor units — the catalogue stores kuruş, as Stripe does. Divided
                here and formatted by `Intl`, so Turkish gets its own grouping
                and a decimal comma without anybody typing a separator.
              */}
              <p className="flex items-baseline gap-1.5">
                {plan.priceMonth === null ? (
                  <span className="text-display">{t("pricingCustom")}</span>
                ) : (
                  <>
                    <span className="text-metric tabular-nums">
                      {format.number(plan.priceMonth / 100, {
                        style: "currency",
                        currency: plan.currency,
                        maximumFractionDigits: 0,
                      })}
                    </span>
                    <span className="text-meta text-faint">{t("pricingPerMonth")}</span>
                  </>
                )}
              </p>

              {shown.length > 0 ? (
                <div className="mt-1">
                  <p className="text-meta text-faint">{t("featureIntro")}</p>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {shown.map((code) => (
                      <li key={code} className="text-copy text-ink-600">
                        {t(`feature.${code}`)}
                      </li>
                    ))}
                    {hidden > 0 ? (
                      <li className="text-copy text-faint">
                        {t("featureMore", { count: hidden })}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
