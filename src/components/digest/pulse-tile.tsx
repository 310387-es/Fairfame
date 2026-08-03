import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";

/**
 * The reputation pulse (P1a-T8).
 *
 * Present but deliberately not the hero. The design brief's first principle is
 * that Home answers "what happened and what should I do", not "here is a wall
 * of charts" — so the number is a tile beside the briefing, and the three
 * actions get the visual weight.
 *
 * The arc is drawn rather than filled as a bar because a pulse is a *level*,
 * not a quantity, and a progress bar invites reading it as completion.
 */

const SIZE = 132;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
/** Three-quarters of a circle, so the gap reads as a gauge rather than a pie. */
const SWEEP = 0.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export type PulseTileProps = {
  score: number | null;
  delta: number | null;
  reviewCount: number;
};

/**
 * Colour bands.
 *
 * Thresholds rather than a continuous gradient: an owner should be able to say
 * "we are in the amber band" without reading a legend, and a smooth ramp makes
 * every week look the same shade of fine.
 */
function bandOf(score: number): { stroke: string; text: string } {
  if (score >= 70) return { stroke: "var(--brand-indigo)", text: "text-primary" };
  if (score >= 45) return { stroke: "var(--brand-amber)", text: "text-rating" };
  return { stroke: "var(--destructive)", text: "text-destructive" };
}

export async function PulseTile({ score, delta, reviewCount }: PulseTileProps) {
  const t = await getTranslations("home");
  const band = score === null ? null : bandOf(score);

  const filled = score === null ? 0 : (score / 100) * SWEEP * CIRCUMFERENCE;
  const track = SWEEP * CIRCUMFERENCE;

  const DeltaIcon = delta === null || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;

  const deltaLabel =
    delta === null
      ? t("noPrior")
      : delta === 0
        ? t("deltaFlat")
        : delta > 0
          ? t("deltaUp", { value: delta.toFixed(1) })
          : t("deltaDown", { value: Math.abs(delta).toFixed(1) });

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6">
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          // Rotated so the gauge opens at the bottom, where the eye expects a
          // dial to start.
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="-rotate-[225deg]"
          role="img"
          aria-label={`${t("pulse")}: ${score === null ? t("noPulse") : score}`}
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${track} ${CIRCUMFERENCE}`}
          />
          {band ? (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={band.stroke}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
            />
          ) : null}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              "font-heading text-4xl font-semibold tabular-nums",
              band?.text ?? "text-muted-foreground",
            )}
          >
            {score === null ? t("noPulse") : Math.round(score)}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("reviewCount", { count: reviewCount })}
          </span>
        </div>
      </div>

      <div className="text-center">
        <p className="text-sm font-medium">{t("pulse")}</p>
        <p className="mt-1 flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <DeltaIcon className="size-3.5 shrink-0" aria-hidden />
          {deltaLabel}
        </p>
      </div>

      <p className="max-w-[16rem] text-center text-[11px] leading-relaxed text-pretty text-muted-foreground">
        {t("pulseHint")}
      </p>
    </div>
  );
}
