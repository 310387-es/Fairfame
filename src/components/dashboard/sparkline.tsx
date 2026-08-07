import { cn } from "@/lib/utils";

/**
 * Seven points of trend, drawn as SVG.
 *
 * **Baselines at the series minimum**, which is what distinguishes it from
 * `ds/sparkline.tsx`'s `VolumeSparkline` — see that file for why the two exist
 * and which quantity each is for. Short version: this draws *bounded* measures
 * (a 1–5 rating, a percentage, a score out of 100), where zero-basing would pin
 * every real business's line flat near the top; a count must use the other one.
 *
 * Deliberately not Recharts. A sparkline has no axes, no tooltip and no
 * interaction — it is one polyline — and rendering four of them through a
 * charting library would turn every KPI card into a client component and ship a
 * charting runtime to draw 28 points. This stays server-rendered and costs
 * nothing. Recharts earns its place on the reputation chart, where hover
 * tooltips and dual axes are the whole point.
 *
 * Decorative by design: `aria-hidden`, because the KPI card already states the
 * value and its change in text. A screen reader gaining "graphic" and seven
 * unlabelled numbers would be noise, not information.
 */

const WIDTH = 70;
const HEIGHT = 30;
const PADDING = 3;

export function TrendSparkline({
  points,
  className,
}: {
  /** `null` where a bucket had no data — the line skips it rather than dipping to zero. */
  points: (number | null)[];
  className?: string;
}) {
  const known = points.filter((point): point is number => point !== null);

  // One point cannot show a trend and an empty series has none to show. Both
  // render as nothing rather than as a flat line, which would read as "steady".
  if (known.length < 2) return null;

  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min;

  const stepX = (WIDTH - PADDING * 2) / (points.length - 1);

  const coordinates = points.map((point, index) => {
    if (point === null) return null;

    // A flat series sits in the middle rather than on the floor: pinning it to
    // the baseline would read as a collapse.
    const ratio = span === 0 ? 0.5 : (point - min) / span;

    return {
      x: PADDING + index * stepX,
      y: HEIGHT - PADDING - ratio * (HEIGHT - PADDING * 2),
    };
  });

  // Gaps break the path into segments instead of drawing a straight line across
  // a period we know nothing about.
  const segments: string[] = [];
  let current: string[] = [];

  for (const coordinate of coordinates) {
    if (coordinate === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${coordinate.x.toFixed(1)},${coordinate.y.toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(" "));

  return (
    // Full width of whatever cell it sits in, not a fixed 70px box. At a fixed
    // size it read as a stray squiggle parked next to the number rather than as
    // that number's history, and four of them at four different widths made the
    // KPI strip look unfinished.
    //
    // `preserveAspectRatio="none"` lets the line stretch to the cell; the shape
    // of a trend is in its ups and downs, not its aspect ratio. Stroke weight is
    // pinned with `non-scaling-stroke`, without which the horizontal stretch
    // would thin the verticals and thicken the horizontals.
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn("h-6 w-full overflow-visible", className)}
    >
      {segments.map((segment) => (
        <polyline
          key={segment}
          points={segment}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
