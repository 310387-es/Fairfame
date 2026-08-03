import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";

/**
 * The card at the foot of the rail: where the account stands, and the one thing
 * to do about it.
 *
 * It replaced a grey pill reading "Trial · 13 days left", which stated a fact
 * and then abandoned the reader — there was no way to act on it without hunting
 * through Settings. Naming the end date makes the countdown concrete, and the
 * amber button is the only call to action in the rail.
 *
 * Amber rather than indigo because indigo is barely visible on ink; this and
 * the briefing bar's button are the only two amber controls in the product.
 *
 * A paid organization gets a quiet line instead. There is nothing to sell, and
 * a permanent button pushing an upgrade to someone who already paid is the kind
 * of nagging this product does not do.
 */
export async function TrialFooter({
  isTrialing,
  trialEndsAt,
  planKey,
}: {
  isTrialing: boolean;
  trialEndsAt: Date | null;
  planKey: string;
}) {
  const [t, format] = await Promise.all([getTranslations("shell"), getFormatter()]);

  if (!isTrialing) {
    return (
      <p className="mt-auto px-[22px] pb-4 text-[10.5px] text-white/50">
        {t("planActive", { plan: planKey })}
      </p>
    );
  }

  return (
    <div className="mx-3 mt-auto mb-3.5 rounded-lg border border-white/12 bg-white/4 p-3">
      <p className="text-[12.5px] font-semibold text-white">
        {t("trialBadge", { days: daysUntil(trialEndsAt) })}
      </p>

      {trialEndsAt ? (
        <p className="mt-0.5 text-[10.5px] text-white/50">
          {t("trialEnds", {
            date: format.dateTime(trialEndsAt, { day: "numeric", month: "long" }),
          })}
        </p>
      ) : null}

      <Link
        href="/settings"
        className="mt-2.5 block rounded-md bg-cta-brief py-[7px] text-center text-[12.5px] font-semibold text-cta-brief-text transition-all hover:brightness-95 focus-visible:ring-3 focus-visible:ring-white/40 focus-visible:outline-none active:translate-y-px"
      >
        {t("trialAction")}
      </Link>
    </div>
  );
}

/**
 * Whole days remaining, rounded up so the last partial day still reads as "1"
 * rather than "0 days left" while the trial is genuinely still active.
 */
function daysUntil(date: Date | null): number {
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}
