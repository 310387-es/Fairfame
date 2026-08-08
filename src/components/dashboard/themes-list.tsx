import { getTranslations } from "next-intl/server";
import { Meter } from "@/components/ds/meter";
import { ChartFallback } from "@/components/dashboard/chart-fallback";
import type { ThemeRow } from "@/dashboard/metrics";
import { isCanonicalTheme } from "@/reviews/taxonomy";

/**
 * What people talked about — the themes panel of the breakdown card.
 *
 * Bar colour is the dominant sentiment, not the count: "cleanliness, 22
 * mentions" means opposite things depending on whether those were compliments
 * or complaints, and a uniformly indigo chart hides the difference.
 *
 * `Meter` rows rather than a Recharts chart. This is a labelled proportion, and
 * rendering it as a div with a width costs no client JavaScript and stays
 * legible with scripts off. The card frame and the sentiment ribbon above it
 * belong to `BreakdownCard`.
 */
export async function ThemesList({ rows }: { rows: ThemeRow[] }) {
  const [t, tThemes] = await Promise.all([
    getTranslations("home.themes"),
    getTranslations("themes"),
  ]);

  /*
    A canonical key becomes a word; anything else is shown as it was written.

    The bars printed `row.slug` raw, so a Turkish account read "bekleme
    süresi" on an English dashboard — the same defect the insight strip above
    had, and the same shape `/analytics` already solved. Free tags pass through
    rather than being dropped: a business analysed before the taxonomy existed
    should see its old themes, not a blank panel.
  */
  const label = (slug: string) =>
    isCanonicalTheme(slug) ? tThemes(slug as Parameters<typeof tThemes>[0]) : slug;

  const mood = (row: ThemeRow) =>
    row.dominant === "negative"
      ? t("mostlyNegative", { count: row.negative })
      : row.dominant === "positive"
        ? t("mostlyPositive", { count: row.positive })
        : t("mixed");

  if (rows.length === 0) {
    return <p className="py-10 text-center text-copy text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <>
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <Meter
            key={row.slug}
            label={label(row.slug)}
            percent={row.share * 100}
            tone={
              row.dominant === "negative"
                ? "negative"
                : row.dominant === "positive"
                  ? "positive"
                  : "neutral"
            }
            value={mood(row)}
            srLabel={`${label(row.slug)}: ${row.count} — ${mood(row)}`}
          />
        ))}
      </div>

      <ChartFallback
        caption={t("title")}
        columns={[t("title"), t("count"), t("mood")]}
        rows={rows.map((row) => ({
          key: row.slug,
          cells: [label(row.slug), row.count, mood(row)],
        }))}
      />
    </>
  );
}
