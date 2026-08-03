import { getTranslations } from "next-intl/server";
import { Meter } from "@/components/ds/meter";
import { ChartFallback } from "@/components/home/chart-fallback";
import type { ThemeRow } from "@/dashboard/metrics";

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
  const t = await getTranslations("home.themes");

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
            label={row.slug}
            percent={row.share * 100}
            tone={
              row.dominant === "negative"
                ? "negative"
                : row.dominant === "positive"
                  ? "positive"
                  : "neutral"
            }
            value={mood(row)}
            srLabel={`${row.slug}: ${row.count} — ${mood(row)}`}
          />
        ))}
      </div>

      <ChartFallback
        caption={t("title")}
        columns={[t("title"), t("count"), t("mood")]}
        rows={rows.map((row) => ({ key: row.slug, cells: [row.slug, row.count, mood(row)] }))}
      />
    </>
  );
}
