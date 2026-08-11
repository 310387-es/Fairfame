"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { HashLink } from "@/components/marketing/hash-link";
import { Reveal } from "@/components/marketing/reveal";
import { PLAN_CATALOG, annualSaving, uniformAnnualDiscount, type PlanKey } from "@/lib/plans";
import { cn } from "@/lib/utils";

/**
 * The public price ladder (`PRODUCT.md` §Commercial Facts).
 *
 * "Transparent public pricing is a positioning pillar" is the reason this
 * section exists at all, and the reason the FAQ repeats the figures: a page
 * that puts numbers behind a demo request contradicts the product it is
 * selling. The section's own headline says so.
 *
 * ## The four things this must not get wrong
 *
 * **There is no free tier.** Every plan starts with a 14-day full-feature
 * trial, which is a different offer, and `PRODUCT.md` forbids the words "free
 * plan" anywhere. The trial grants top-tier entitlements — that is why the
 * sub-line calls it full-feature rather than a trial of Starter.
 *
 * **Billing is base + extras, not per location** (11 Aug 2026 — docs/05 §2).
 * Each tier includes N locations and prices the rest, so the unit line here
 * said "/ location · month" and was describing a model the product no longer
 * has: it read as though Starter's $29 multiplied by branch, and as though
 * Pro's $229 bought one. A monthly figure that turns out to mean something
 * else at checkout is the exact surprise this page is positioned against, so
 * the tiers that *can* cost more say "from" and the one that cannot does not.
 *
 * **Agency is not the top of the ladder.** It is a different shape — priced
 * per deal, sold to a different buyer — so it carries no figure and its call
 * to action is a conversation rather than a trial. `docs/20` treats agencies
 * as a first-class audience, not an enterprise upsell.
 *
 * **The footnote is load-bearing.** Repricing and metered add-ons are stated
 * here, once, in the place the number is. Sends and heavy AI use are real
 * marginal cost; saying so beside the price is the honest version of a plan
 * that would otherwise have to hide the ceiling.
 *
 * **The figures come from `PLAN_CATALOG`, not from the message catalogue.**
 * They used to be four hardcoded strings per locale — eight numbers with
 * nothing tying them to what the product charges. They were correct only
 * because somebody had lately typed them correctly, and the failure mode is the
 * worst one a pricing page has: the front door quoting last quarter's ladder
 * while checkout charges this quarter's. The catalogue still owns the *words*
 * around the number; the number itself is read from the same object the
 * entitlement checks and the billing screen read.
 *
 * Read from the catalogue rather than the `plans` table on purpose. The values
 * are identical — `pnpm db:seed` writes one from the other, and migration 0058
 * pins them — but this page is public, unauthenticated and heavily cached, so a
 * database round trip buys nothing and an unseeded database would render a
 * pricing section with no prices in it.
 */

/**
 * Every message key written out rather than assembled from the tier's name.
 *
 * `scripts/check-i18n.mts` can only see a key it can read as a literal, and a
 * line nothing can prove is referenced is a line nobody dares delete when the
 * packaging changes. The repetition is what makes the dead-string check work on
 * the strings that cost money to get wrong.
 */
const TIERS = [
  {
    id: "starter",
    name: "pricing.starterName",
    features: [
      "pricing.starterOne",
      "pricing.starterTwo",
      "pricing.starterThree",
      "pricing.starterFour",
    ],
    featured: false,
  },
  {
    id: "growth",
    name: "pricing.growthName",
    features: [
      "pricing.growthOne",
      "pricing.growthTwo",
      "pricing.growthThree",
      "pricing.growthFour",
    ],
    featured: true,
  },
  {
    id: "pro",
    name: "pricing.proName",
    features: ["pricing.proOne", "pricing.proTwo", "pricing.proThree", "pricing.proFour"],
    featured: false,
  },
  {
    id: "agency",
    name: "pricing.agencyName",
    features: [
      "pricing.agencyOne",
      "pricing.agencyTwo",
      "pricing.agencyThree",
      "pricing.agencyFour",
    ],
    featured: false,
  },
] as const;

export function Pricing() {
  const t = useTranslations("marketing");
  const format = useFormatter();

  /**
   * The price line, built from the catalogue.
   *
   * One interpolated string per shape rather than an amount styled large beside
   * a small unit, because the pieces do not sit in the same order in both
   * languages: English puts "from" before the number and "/ month" after it,
   * Turkish carries both as "aylık … 'dan". A split that looks right in English
   * puts the words in the wrong places in the launch locale — the same trap
   * `src/components/billing/plan-section.tsx` records. `t.rich` lets each
   * translation decide the order while still marking which part is the figure.
   *
   * **"from" appears only where an extra location can actually be bought.**
   * Starter is the single-location plan with no purchasable extras, so $29 is
   * not a starting price, it is the price; saying "from" there would overstate
   * the cost in the one place a visitor is deciding whether to bother.
   */
  const [interval, setInterval] = useState<"month" | "year">("month");

  const money = (minorUnits: number, currency: string) =>
    format.number(minorUnits / 100, {
      style: "currency",
      // From the row, never a typed "$": a hardcoded symbol is how a price ends
      // up rendered in a currency nobody is charged in.
      currency,
      maximumFractionDigits: 0,
    });

  const priceLine = (key: PlanKey) => {
    const plan = PLAN_CATALOG[key];
    const big = (chunks: React.ReactNode) => (
      <span className="text-display tabular-nums">{chunks}</span>
    );

    // Agency carries no figure at all: it is priced per deal, and a number here
    // would be one sales will not honour.
    if (plan.priceMonth === null) return big(t("pricing.agencyPrice"));

    if (interval === "year" && plan.priceYear !== null) {
      const amount = money(plan.priceYear, plan.currency);
      return plan.priceExtraLocationYear === null
        ? t.rich("pricing.priceExactYear", { amount, big })
        : t.rich("pricing.priceFromYear", { amount, big });
    }

    const amount = money(plan.priceMonth, plan.currency);
    return plan.priceExtraLocationMonth === null
      ? t.rich("pricing.priceExact", { amount, big })
      : t.rich("pricing.priceFrom", { amount, big });
  };

  const discount = uniformAnnualDiscount();

  return (
    <>
      {/*
        The billing-period toggle, in the **brand** layer's own palette.
        `docs/24`: paper and the app's cool canvas share ink, amber, indigo and
        the seal and nothing else, so this is not the settings control restyled
        — it is the same idea drawn in the other language. Amber carries the
        saving here because amber is this layer's accent; the app's version uses
        the product's positive green, which has no meaning on paper.

        Local state and Radix `Tabs`, same rule as the settings screen: both
        prices ship with the page, so switching is a re-render.
      */}
      <Tabs.Root
        value={interval}
        onValueChange={(value) => setInterval(value === "year" ? "year" : "month")}
        className="mb-6"
      >
        <Tabs.List
          aria-label={t("pricing.billingPeriod")}
          className="inline-flex rounded-full border border-paper-line bg-white p-1"
        >
          {(["month", "year"] as const).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                "tap rounded-full px-4 py-1.5 text-copy font-semibold transition-colors",
                interval === value
                  ? "bg-brand-ink text-white"
                  : "text-paper-faint hover:text-brand-ink",
              )}
            >
              {value === "month" ? t("pricing.monthly") : t("pricing.annual")}
              {/*
                Words, not colour alone (`docs/15` §3) — and inside the trigger,
                so the saving is part of the control's accessible name rather
                than a chip a screen reader never reaches.
              */}
              {value === "year" && discount !== null ? (
                <span
                  className={cn(
                    "ms-1.5 text-eyebrow",
                    // `--amber-ink` is 5.5:1 on paper and 5.9:1 on white, so it
                    // is legible on the pill in both states.
                    interval === "year" ? "text-brand-amber" : "text-amber-ink",
                  )}
                >
                  {t("pricing.savePercent", { percent: discount })}
                </span>
              ) : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      <div className="grid items-stretch gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {TIERS.map(({ id, name, features, featured }) => {
          const agency = id === "agency";
          return (
            <Reveal key={id}>
              <div
                className={cn(
                  "relative flex h-full flex-col rounded-2xl border bg-white p-6",
                  featured ? "border-brand-ink" : "border-paper-line",
                )}
              >
                {featured && (
                  <span className="absolute start-5 -top-2.5 rounded-md bg-amber-500 px-2.5 py-0.5 text-eyebrow font-bold text-brand-rail uppercase">
                    {t("pricing.growthBadge")}
                  </span>
                )}

                <h3 className="mb-2 text-lead font-semibold">{t(name)}</h3>

                {/* The qualifier is the paragraph's own size; the figure inside
                  it is promoted by the `big` tag the translation places. */}
                <p className="mb-1 text-meta text-paper-faint">{priceLine(id)}</p>

                {/* The amount, not just the ratio — a figure a reader can weigh
                  against what they were about to spend. */}
                <p className="mb-3.5 h-4 text-meta font-semibold text-amber-ink">
                  {interval === "year" && annualSaving(PLAN_CATALOG[id]) !== null
                    ? t("pricing.savesPerYear", {
                        amount: money(annualSaving(PLAN_CATALOG[id])!, PLAN_CATALOG[id].currency),
                      })
                    : ""}
                </p>

                <ul className="mb-4 flex flex-1 flex-col gap-2">
                  {features.map((feature) => (
                    <li key={feature} className="relative ps-4 text-copy text-paper-body">
                      <span aria-hidden className="absolute start-0 text-amber-ink">
                        —
                      </span>
                      {t(feature)}
                    </li>
                  ))}
                </ul>

                <HashLink
                  href="#cta"
                  className={cn(
                    "tap justify-center rounded-[10px] border px-3.5 py-2.5 text-center text-copy font-semibold",
                    featured
                      ? "border-brand-ink bg-brand-ink text-white"
                      : "border-paper-line hover:border-brand-ink",
                  )}
                >
                  {agency ? t("agency.cta") : t("hero.cta1")}
                </HashLink>
              </div>
            </Reveal>
          );
        })}
      </div>
    </>
  );
}
