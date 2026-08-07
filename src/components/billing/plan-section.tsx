"use client";

import { Check, CreditCard } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ds/meter";
import { useAction } from "@/components/ui/use-action";
import { startCheckoutAction } from "@/server/billing";
import { cn } from "@/lib/utils";
import type { PlanKey } from "@/lib/plans";

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

  const price = (plan: PlanOption) =>
    plan.priceMonth === null
      ? t("quoted")
      : t("perMonth", {
          amount: format.number(plan.priceMonth / 100, {
            style: "currency",
            currency: plan.currency,
            maximumFractionDigits: 0,
          }),
        });

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
            {usage.map((row) => (
              <Meter
                key={row.label}
                label={row.label}
                // Unlimited has no proportion to draw. The bar reads empty and
                // the figure beside it says "unlimited" in words, rather than a
                // full or empty bar that would mean neither.
                percent={row.limit === null ? 0 : (row.used / Math.max(row.limit, 1)) * 100}
                value={
                  row.limit === null
                    ? t("unlimited", { used: row.used })
                    : t("ofLimit", { used: row.used, limit: row.limit })
                }
                srLabel={
                  row.limit === null
                    ? t("unlimited", { used: row.used })
                    : t("ofLimit", { used: row.used, limit: row.limit })
                }
              />
            ))}
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
                    onClick={() => run(() => startCheckoutAction({ planKey: plan.key }))}
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
