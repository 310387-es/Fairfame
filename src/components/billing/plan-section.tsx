"use client";

import { Check, CreditCard } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { segmentedItem, segmentedTrough } from "@/components/ds/segmented";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ds/meter";
import { useAction } from "@/components/ui/use-action";
import { startCheckoutAction } from "@/server/billing";
import { cn } from "@/lib/utils";
import { PLAN_CATALOG, annualSaving, uniformAnnualDiscount, type PlanKey } from "@/lib/plans";

/**
 * What this business is on, what else there is, and how to move (W1.8).
 *
 * **What it replaces: nothing.** The trial footer has said "Choose a plan"
 * since Phase 0 and linked to a Settings page with no plans on it — the product
 * asked for money and then had nowhere to take it. An owner who follows a
 * call to action and finds it goes nowhere has learned something true about how
 * finished the product is.
 *
 * Everything here comes from `PLAN_CATALOG`, which is the same config the
 * entitlement checks read. A price on this screen and a limit in the product
 * cannot disagree, because they are the same object.
 */

export type PlanOption = {
  key: PlanKey;
  name: string;
  /** Minor units, or null for a plan that is quoted rather than sold. */
  priceMonth: number | null;
  /** Annual price in minor units — 10× monthly, so two months are free. Null = no annual option. */
  priceYear: number | null;
  currency: string;
  /** What this tier adds over the one below it — three lines, not a matrix. */
  highlights: string[];
};

export type UsageRow = {
  label: string;
  used: number;
  /** Null is unlimited. It never means zero. */
  limit: number | null;
};

export function PlanSection({
  current,
  isTrialing,
  trialEndsAt,
  plans,
  usage,
  canCheckout,
  canManage,
}: {
  current: PlanKey;
  isTrialing: boolean;
  /** ISO string: this crosses the server/client boundary. */
  trialEndsAt: string | null;
  plans: PlanOption[];
  usage: UsageRow[];
  /** Whether a payment provider is configured for this organization's currency. */
  canCheckout: boolean;
  /** Owner only — a bill is not an admin decision. */
  canManage: boolean;
}) {
  const t = useTranslations("billing");
  const format = useFormatter();
  const { run, pending } = useAction();

  const money = (minorUnits: number, currency: string) =>
    format.number(minorUnits / 100, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    });

  /**
   * Monthly or annual, and it is a toggle now (11 Aug 2026).
   *
   * This card used to print the annual figure as a line under the monthly one,
   * on the argument that "a billing card in settings is read to check what is
   * being paid, not to reconfigure a subscription, and a switch would ask a
   * question nobody came here with". That was right while annual was
   * unbuyable — checkout sent one line item at `priceMonth` regardless, so a
   * switch would have offered a choice the payment path could not honour.
   *
   * Both prices are now real, so the question is one somebody *does* arrive
   * with, and it has to be asked before the button is pressed rather than
   * afterwards.
   *
   * **Local state, not the URL**, and Radix `Tabs` rather than links — the rule
   * `docs/15` §5 states: the URL owns what the server needs to know, local state
   * owns which of several things already on the page you are looking at. Both
   * prices ship with the page, so switching is a re-render and not a round trip.
   */
  const [interval, setInterval] = useState<"month" | "year">("month");

  const price = (plan: PlanOption) => {
    if (plan.priceMonth === null) return t("quoted");

    return interval === "month"
      ? t("perMonth", { amount: money(plan.priceMonth, plan.currency) })
      : t("perYear", { amount: money(plan.priceYear ?? 0, plan.currency) });
  };

  /**
   * What the other option costs, as the line underneath.
   *
   * Always the *alternative* to whatever is selected, so the card answers "and
   * if I picked the other one?" without making anybody flip the switch to find
   * out. Absent for Agency, which is quoted and has no second figure.
   */
  const alternative = (plan: PlanOption) => {
    if (plan.priceMonth === null || plan.priceYear === null) return null;

    return interval === "month"
      ? t("orPerYear", { amount: money(plan.priceYear, plan.currency) })
      : t("orPerMonth", { amount: money(plan.priceMonth, plan.currency) });
  };

  /**
   * The saving, from `src/lib/plans.ts` rather than computed here.
   *
   * The public pricing section shows the same figure in a different palette,
   * and two components deriving it separately is two places for it to drift.
   * `PlanOption` is this screen's own shape, so the catalog entry is what gets
   * asked.
   */
  const saving = (plan: PlanOption) => annualSaving(PLAN_CATALOG[plan.key]);
  const headlineDiscount = uniformAnnualDiscount();

  return (
    <SectionCard
      id="plan"
      title={t("title")}
      icon={CreditCard}
      meta={
        isTrialing && trialEndsAt
          ? t("trialEnds", { date: format.dateTime(new Date(trialEndsAt), "long") })
          : undefined
      }
      className="scroll-mt-20"
    >
      <div className="flex flex-col gap-5 pb-(--card-py)">
        {/* Said once, above the tiers, rather than under each of them. It is
            one fact about the organization — not three facts about three
            plans — and repeating it made the section read as three failures. */}
        {canManage && !canCheckout ? (
          <p className="text-body text-pretty text-ink-400">{t("notAvailable")}</p>
        ) : null}

        {/* Usage first: "what am I actually using" is the question somebody
            opens this section with, and it is the one that decides whether the
            prices below matter to them at all. */}
        {usage.length > 0 ? (
          <div className="flex flex-col gap-3">
            {usage.map((row) => {
              const value =
                row.limit === null
                  ? t("unlimited", { used: row.used })
                  : t("ofLimit", { used: row.used, limit: row.limit });

              /*
                No limit, no bar.

                This drew a `Meter` at `percent={0}` for an unlimited
                allowance, on the reasoning that an empty track is the honest
                drawing of "no proportion to state". On screen it is not: an
                empty track is the *same* drawing as nought per cent used, so a
                business on three requests and a business on five hundred get an
                identical empty bar, each contradicting the figure beside it. A
                progress bar asserts that a maximum exists — that is what the
                right-hand end of it means — and on an unlimited plan there
                isn't one.

                The same rule the rest of this codebase already keeps: absence
                is not zero. `percent={0}` was exactly the `null → 0` mistake
                `src/analytics/trends.ts` refuses to make.
              */
              if (row.limit === null) {
                return (
                  <div
                    key={row.label}
                    className="flex items-baseline justify-between gap-4 text-copy"
                  >
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="tabular-nums">{value}</span>
                  </div>
                );
              }

              return (
                <Meter
                  key={row.label}
                  label={row.label}
                  percent={(row.used / Math.max(row.limit, 1)) * 100}
                  value={value}
                  srLabel={value}
                />
              );
            })}
          </div>
        ) : null}

        {/*
          Two across until a very wide screen, where it was four at `xl`.

          Four tiers in a 1060px card is a 230px column, and 230px is what made
          these read as four boxes rather than a price list: there was no room
          for the price to be the biggest thing on the card, so it sat at body
          size next to the plan name and the whole surface flattened. This is the
          screen where the product asks for money; it can afford the height.
        */}
        {/*
          Directly above the prices it changes, and only where it can do
          anything: an owner who cannot check out is shown the tiers as a price
          list, and a switch there would be a control that changes numbers
          nobody can act on.
        */}
        {canManage && canCheckout ? (
          <Tabs.Root
            value={interval}
            onValueChange={(value) => setInterval(value === "year" ? "year" : "month")}
          >
            <Tabs.List aria-label={t("billingPeriod")} className={segmentedTrough("sm")}>
              {(["month", "year"] as const).map((value) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className={segmentedItem("sm", interval === value)}
                >
                  {value === "month" ? t("monthly") : t("annual")}
                  {/*
                    The saving, on the control that grants it.

                    `docs/15` §3: "never say it in colour alone" — the chip
                    carries the words, and the colour only makes them findable.
                    `--state-positive-*` rather than amber, which this system
                    reserves for ratings and never puts on a white surface, and
                    rather than indigo, which means *interaction* here and not
                    "good".
                  */}
                  {value === "year" && headlineDiscount !== null ? (
                    <span className="ml-1.5 rounded-sm bg-state-positive-bg px-1 py-px text-eyebrow text-state-positive-text">
                      {t("savepercent", { percent: headlineDiscount })}
                    </span>
                  ) : null}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs.Root>
        ) : null}

        <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          {plans.map((plan, index) => {
            const isCurrent = plan.key === current;
            /*
              `plans` arrives in `PLAN_CATALOG` order, which is ascending, so an
              index above the current one is an upgrade. That is the only thing
              deciding button emphasis — moving up is the action this screen is
              for, moving down is a decision somebody has already made elsewhere
              and does not need encouraging with an indigo button.
            */
            const currentIndex = plans.findIndex((option) => option.key === current);
            const isUpgrade = currentIndex !== -1 && index > currentIndex;

            return (
              <li
                key={plan.key}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border p-4 transition-colors",
                  // The plan you are on is the fact this section exists to
                  // state. It had a small badge and nothing else, so finding it
                  // meant reading four cards; now it is the one that is lit.
                  isCurrent
                    ? "border-indigo-600 bg-state-accent-bg/40 ring-1 ring-indigo-600"
                    : "border-line bg-card",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-eyebrow text-faint uppercase">{plan.name}</span>
                  {isCurrent ? (
                    <Badge variant="positive">
                      {isTrialing ? t("currentTrial") : t("current")}
                    </Badge>
                  ) : null}
                </div>

                {/*
                  The price leads, and the plan name became its label above.

                  It was `text-body` mono — the same size as the feature lines
                  under it — so the one number somebody is here to compare had no
                  more weight than "Up to 3 locations".

                  One string, not an amount styled large beside a small "/
                  month": Turkish is `aylık {amount}`, so the period comes
                  *before* the number and any split that looks right in English
                  puts the pieces in the wrong order in the launch locale.
                */}
                <p className="text-metric text-foreground tabular-nums">{price(plan)}</p>
                {interval === "year" && saving(plan) !== null ? (
                  <p className="text-copy font-medium text-state-positive-text tabular-nums">
                    {t("savesPerYear", {
                      amount: money(saving(plan)!, plan.currency),
                    })}
                  </p>
                ) : null}

                {alternative(plan) === null ? null : (
                  <p className="text-copy text-ink-400 tabular-nums">{alternative(plan)}</p>
                )}

                <ul className="flex flex-1 flex-col gap-1.5">
                  {plan.highlights.map((line) => (
                    <li key={line} className="flex gap-2 text-copy text-ink-600">
                      <Check
                        className="mt-0.5 size-3.5 shrink-0 text-state-positive-text"
                        aria-hidden
                      />
                      {line}
                    </li>
                  ))}
                </ul>

                {/*
                  A button only when pressing it can work. The two reasons it
                  might not are said elsewhere — "priced per deal" here, because
                  it is a fact about *this* tier, and "we cannot bill your
                  currency" once above, because it is a fact about the account.

                  `mt-auto` on every branch, including the text one: the Agency
                  tier has prose where the others have a control, and without it
                  that card's copy floated up and left the row of buttons ragged.
                */}
                {isCurrent || !canManage ? null : plan.priceMonth === null ? (
                  <p className="mt-auto text-copy text-ink-400">{t("contactUs")}</p>
                ) : canCheckout ? (
                  <Button
                    className="mt-auto w-full"
                    // Indigo to move up, outline to move down. Four identical
                    // outline buttons asked the reader to work out which one was
                    // the offer.
                    variant={isUpgrade ? "default" : "outline"}
                    disabled={pending}
                    onClick={() => run(() => startCheckoutAction({ planKey: plan.key, interval }))}
                  >
                    {t("choose", { plan: plan.name })}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </SectionCard>
  );
}
