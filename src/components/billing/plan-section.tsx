"use client";

import { Check, CreditCard } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/ds/meter";
import { useAction } from "@/components/ui/use-action";
import { startCheckoutAction } from "@/server/billing";
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

        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => {
            const isCurrent = plan.key === current;

            return (
              <li
                key={plan.key}
                className="flex flex-col gap-2 rounded-md border border-line p-3.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-title">{plan.name}</span>
                  {isCurrent ? (
                    <Badge variant="positive">
                      {isTrialing ? t("currentTrial") : t("current")}
                    </Badge>
                  ) : null}
                </div>

                <p className="font-mono text-body tabular-nums">{price(plan)}</p>

                <ul className="flex flex-1 flex-col gap-1">
                  {plan.highlights.map((line) => (
                    <li key={line} className="flex gap-1.5 text-copy text-ink-400">
                      <Check
                        className="mt-0.5 size-3.5 shrink-0 text-state-positive-text"
                        aria-hidden
                      />
                      {line}
                    </li>
                  ))}
                </ul>

                {/*
                  Three reasons this button may not appear, and each says
                  something different. A single disabled control would say none
                  of them, which is the failure this whole work package is about.
                */}
                {/*
                  A button only when pressing it can work. The two reasons it
                  might not are said elsewhere — "priced per deal" here, because
                  it is a fact about *this* tier, and "we cannot bill your
                  currency" once above, because it is a fact about the account.
                */}
                {isCurrent || !canManage ? null : plan.priceMonth === null ? (
                  <p className="text-copy text-ink-400">{t("contactUs")}</p>
                ) : canCheckout ? (
                  <Button
                    size="sm"
                    variant="outline"
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
