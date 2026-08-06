import { CalendarRange, Inbox, Send } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RANGES, type Range } from "@/dashboard/range";

/**
 * Two empty states, because there are two empties.
 *
 * A location with no reviews at all needs a way to get some — connect a source
 * or send requests. A location that simply had a quiet 7 days needs a longer
 * window, not onboarding advice it outgrew months ago. Telling a business with
 * 800 reviews to "connect a source" is the kind of small insult that makes a
 * product feel like it is not paying attention.
 */
export async function DashboardEmpty({
  reason,
  range,
}: {
  reason: "no_sources" | "quiet_period";
  range: Range;
}) {
  const t = await getTranslations("home.empty");

  // The next range up, so the suggestion is a link rather than an instruction.
  const wider = RANGES[Math.min(RANGES.indexOf(range) + 1, RANGES.length - 1)] ?? "90d";

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <span className="grid size-11 place-items-center rounded-lg bg-surface-sunken text-ink-400">
          {reason === "no_sources" ? (
            <Inbox className="size-5" aria-hidden />
          ) : (
            <CalendarRange className="size-5" aria-hidden />
          )}
        </span>

        {/* The card-title role, not a fourth heading size. An empty state is a
            result the page is reporting, not a second page-level headline. */}
        <h2 className="text-title">{t(`${reason}.title`)}</h2>
        <p className="max-w-md text-body text-pretty text-ink-400">{t(`${reason}.body`)}</p>

        {reason === "no_sources" ? (
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button asChild size="sm">
              <Link href="/locations">{t("connect")}</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/get-reviews">
                <Send className="size-4" aria-hidden />
                {t("request")}
              </Link>
            </Button>
          </div>
        ) : range !== "90d" ? (
          <Button asChild size="sm" variant="outline" className="mt-2">
            <Link href={`/dashboard?range=${wider}`}>{t(`widen.${wider}`)}</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
