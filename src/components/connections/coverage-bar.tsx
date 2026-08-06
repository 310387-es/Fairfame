import { getTranslations } from "next-intl/server";
import { SectionCard } from "@/components/ds/section-card";

/**
 * "3 of 5 sources connected" — the one number the screen exists to answer
 * (W4.2).
 *
 * **The denominator is what this deployment could connect**, not everything the
 * product might one day read. Counting the roadmap would pin the bar near zero
 * forever and read as a product that is mostly missing, when the honest claim
 * is "you have connected three of the three things available to you". The
 * roadmap gets its own section, with its own promise.
 *
 * **Attention is a separate sentence, not a colour on the bar.** A business
 * with everything connected and one source failing has full coverage and a
 * problem, and blending those into one bar would let the good number hide the
 * bad one. Segments rather than a single fill for the same reason: the part
 * that is connected-but-unwell is drawn apart from the part that is working.
 */
export async function CoverageBar({
  connected,
  total,
  attention,
}: {
  connected: number;
  total: number;
  attention: number;
}) {
  const t = await getTranslations("connections");

  const healthy = Math.max(0, connected - attention);
  const share = (value: number) => (total === 0 ? 0 : (value / total) * 100);

  return (
    <SectionCard
      title={t("coverageTitle")}
      meta={t("coverageCount", { connected, total })}
      action={
        attention > 0 ? (
          <span className="text-copy font-medium text-state-negative-text">
            {t("coverageAttention", { count: attention })}
          </span>
        ) : null
      }
    >
      <div
        role="img"
        aria-label={t("coverageSr", { connected, total, attention })}
        className="flex h-[9px] gap-0.5 overflow-hidden rounded-[5px] bg-surface-sunken"
      >
        <span className="bg-primary" style={{ width: `${share(healthy)}%` }} />
        <span className="bg-sentiment-negative" style={{ width: `${share(attention)}%` }} />
      </div>
    </SectionCard>
  );
}
