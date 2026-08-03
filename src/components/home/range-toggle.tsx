import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { RANGES, type Range } from "@/dashboard/range";
import { cn } from "@/lib/utils";

/**
 * The 7d / 30d / 90d segmented control.
 *
 * Three links rather than a client-side control with state. The range lives in
 * the URL so it can be shared and bookmarked, and links get that for free —
 * along with middle-click, back-button history and working before JavaScript
 * loads. A `<button>` here would need `useRouter`, a client boundary and its
 * own handling of every one of those, to arrive at the same place.
 *
 * `aria-current` rather than colour alone: the active segment is announced, and
 * a reader who cannot see the white pill still knows which window they are in.
 */
export async function RangeToggle({ active }: { active: Range }) {
  const t = await getTranslations("home");

  return (
    <nav
      aria-label={t("rangeLabel")}
      className="inline-flex rounded-lg bg-muted p-0.5 text-xs font-semibold"
    >
      {RANGES.map((range) => {
        const current = range === active;

        return (
          <Link
            key={range}
            href={`/home?range=${range}`}
            aria-current={current ? "true" : undefined}
            aria-label={t(`range.${range}.long`)}
            className={cn(
              "rounded-[7px] px-3 py-1.5 transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none",
              current
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`range.${range}.short`)}
          </Link>
        );
      })}
    </nav>
  );
}
