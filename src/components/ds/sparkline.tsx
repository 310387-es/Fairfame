import { cn } from "@/lib/utils";

/**
 * A **count** over time: thirty numbers, no axes, no tooltip (W4.2).
 *
 * **There are two sparklines in this product and they are not interchangeable.**
 * This one baselines at **zero**; `dashboard/sparkline.tsx`'s `TrendSparkline`
 * baselines at the series **minimum**. Both are correct for what they draw, and
 * the choice is decided by the quantity, not by taste:
 *
 *   - A **count** (reviews per day) must start at zero, or 4,5,4,5 draws the
 *     same dramatic zigzag as 0,50,0,50 and the height of a line stops meaning
 *     anything across cards.
 *   - A **bounded measure** (a 1–5 rating, a percentage) must not. Zero-based,
 *     every rating a real business has ever had is a flat line pinned near the
 *     top, which is a chart that has thrown away its only information.
 *
 * They were both called `Sparkline`, in two folders, so which one you got
 * depended on what your editor autocompleted. The names say the baseline now.
 *
 * Hand-rolled SVG rather than Recharts, which the analytics charts use. Two
 * reasons, and the first is the one that matters: Recharts is client-only, so
 * every card carrying one would drag a chart runtime and a hydration boundary
 * onto a page that is otherwise entirely server-rendered. The second is that a
 * sparkline has no axes, no legend, no tooltip and no interaction — everything
 * a chart library is for is switched off, and what is left is a polyline.
 *
 * **It is decoration, and it says so.** `aria-hidden`, because a screen reader
 * reading thirty numbers as a trend is worse than silence; the total beside it
 * is the accessible version of the same fact, and it is always rendered.
 *
 * **The baseline is zero, not the minimum.** A sparkline scaled to its own
 * range turns 4,5,4,5 into a dramatic zigzag — visually identical to 0,50,0,50.
 * These sit next to each other on one screen and get compared, so the height of
 * a line has to mean the same thing on every card.
 */

export function VolumeSparkline({
  values,
  className,
  width = 96,
  height = 24,
}: {
  values: number[];
  className?: string;
  width?: number;
  height?: number;
}) {
  // Nothing at all is not a flat line at zero — a flat line is a claim about
  // thirty quiet days. Render nothing and let the caller's total say "0".
  if (values.length === 0) return null;

  const peak = Math.max(...values, 0);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  // Half a stroke of padding top and bottom so a peak is not clipped and a
  // run of zeroes sits on the baseline rather than under it.
  const pad = 1.5;
  const usable = height - pad * 2;

  const y = (value: number) => (peak === 0 ? height - pad : height - pad - (value / peak) * usable);

  const points = values.map((value, index) => `${index * step},${y(value)}`).join(" ");
  const area = `${points} ${width},${height - pad} 0,${height - pad}`;

  return (
    <svg
      className={cn(className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      focusable="false"
      preserveAspectRatio="none"
    >
      <polygon points={area} className="fill-chart-1/12" />
      <polyline
        points={points}
        fill="none"
        className="stroke-chart-1"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
