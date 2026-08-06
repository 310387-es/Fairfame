import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/card";
import { RATING_WEIGHT, SENTIMENT_WEIGHT } from "@/digest/metrics";
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
 * Colour bands, from the rating ramp.
 *
 * Thresholds rather than a continuous gradient: an owner should be able to say
 * "we are in the amber band" without reading a legend, and a smooth ramp makes
 * every week look the same shade of fine.
 *
 * These used to be `--brand-indigo` / `--brand-amber` / `--destructive`, which
 * predate the design system and broke its clearest rule: **indigo carries
 * interaction and nothing else** (docs/15 §2). A good pulse painted in the same
 * blue as every link and button said "this is clickable", not "this is
 * healthy". The rating ramp is the scale built for exactly this — five rungs,
 * green → red, each the lightest value of its hue that still clears 4.5:1.
 */
function bandOf(score: number): { stroke: string; text: string } {
  if (score >= 70) return { stroke: "var(--rating-5)", text: "text-rating-5" };
  if (score >= 45) return { stroke: "var(--rating-3)", text: "text-rating-3" };
  return { stroke: "var(--rating-1)", text: "text-rating-1" };
}

export async function PulseTile({ score, delta, reviewCount }: PulseTileProps) {
  const [t, format] = await Promise.all([getTranslations("digest"), getFormatter()]);
  const band = score === null ? null : bandOf(score);

  const filled = score === null ? 0 : (score / 100) * SWEEP * CIRCUMFERENCE;
  const track = SWEEP * CIRCUMFERENCE;

  const DeltaIcon = delta === null || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;

  // Locale-formatted, never `toFixed`. Turkish writes a decimal comma, and
  // this tile sits one screen away from a dashboard that prints "11,2" — two
  // numbers in the same product disagreeing about punctuation reads as a bug.
  const deltaLabel =
    delta === null
      ? t("noPrior")
      : delta === 0
        ? t("deltaFlat")
        : delta > 0
          ? t("deltaUp", { value: format.number(delta, { maximumFractionDigits: 1 }) })
          : t("deltaDown", {
              value: format.number(Math.abs(delta), { maximumFractionDigits: 1 }),
            });

  return (
    <Card className="items-center gap-3 px-(--card-px)">
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
            // `--surface-sunken` is the documented meter-track colour; `--muted`
            // is a shadcn default this file predates.
            stroke="var(--surface-sunken)"
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
          {/* `text-metric` alone — it is already the headline-number role at
              28px, and the `text-[2rem]` that used to override it was exactly
              the hand-typed font size docs/15 opens by forbidding. */}
          {/*
            The number, or the reason there is not one (W3.3).

            `noPulse` used to be an em-dash, and a dash in a dial is a rendering
            failure to everyone who has not read `MIN_REVIEWS_FOR_PULSE` —
            somebody with three reviews concluded the gauge was broken rather
            than that three reviews are not a reputation. It is a sentence now,
            and at `text-copy` rather than `text-metric`: twenty-eight-point
            type is for a two-digit number, and "Yeterli veri yok" set at that
            size does not fit inside a 120px circle.
          */}
          {score === null ? (
            <span className="max-w-[6.5rem] text-center text-copy text-pretty text-muted-foreground">
              {t("noPulse")}
            </span>
          ) : (
            <span className={cn("text-metric", band?.text ?? "text-muted-foreground")}>
              {Math.round(score)}
            </span>
          )}
          <span className="text-copy text-muted-foreground">
            {t("reviewCount", { count: reviewCount })}
          </span>
        </div>
      </div>

      <div className="text-center">
        <p className="text-title">{t("pulse")}</p>
        <p className="mt-1 flex items-center justify-center gap-1 text-copy text-muted-foreground">
          <DeltaIcon className="size-3.5 shrink-0" aria-hidden />
          {deltaLabel}
        </p>
      </div>

      <p className="max-w-[16rem] text-center text-meta leading-relaxed text-pretty text-faint">
        {/* The same sentence the dashboard's tooltip carries, with the weights
            taken from the maths rather than typed in (W3.3). This surface has
            room to show it outright, which is better than a tooltip: a phone
            has no hover. */}
        {t("pulseHint", {
          rating: Math.round(RATING_WEIGHT * 100),
          sentiment: Math.round(SENTIMENT_WEIGHT * 100),
        })}
      </p>
    </Card>
  );
}
