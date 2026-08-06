import { getTranslations } from "next-intl/server";
import { Segmented } from "@/components/ds/segmented";
import { RANGES, type Range } from "@/dashboard/range";

/**
 * The 7d / 30d / 90d control.
 *
 * Stays in the URL, unlike the breakdown card's tab strip: this genuinely
 * changes what the server fetches, and a shared or bookmarked link has to carry
 * it. The rule is that the URL owns what the server needs to know, and local
 * state owns which of several things already on the page you are looking at.
 *
 * Built on the shared `Segmented`, which is where the reasoning for links over
 * client state lives.
 */
export async function RangeToggle({
  active,
  basePath = "/dashboard",
}: {
  active: Range;
  /** Which page the links point back at — Home and Insights share this control. */
  basePath?: string;
}) {
  const t = await getTranslations("home");

  return (
    <Segmented
      label={t("rangeLabel")}
      items={RANGES.map((range) => ({
        href: `${basePath}?range=${range}`,
        // The long form names the window for a screen reader; the short form is
        // what fits in a 40px pill.
        label: t(`range.${range}.long`),
        short: t(`range.${range}.short`),
        active: range === active,
      }))}
    />
  );
}
