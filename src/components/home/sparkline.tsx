import { cn } from "@/lib/utils";

/**
 * Seven points of trend, drawn as SVG.
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

export function Sparkline({
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
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      aria-hidden
      className={cn("shrink-0 overflow-visible", className)}
    >
      {segments.map((segment) => (
        <polyline
          key={segment}
          points={segment}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
