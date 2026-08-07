import { CalendarRange, Inbox, Send } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ds/empty-state";
import { Card } from "@/components/ui/card";
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
      {/*
        Through `EmptyState`, which is now the product's one layout for this.

        The two *reasons* stay — that distinction is the whole point of this
        component and no shared primitive should flatten it — but the icon
        tile, the title, the body and the spacing are no longer a fourth
        hand-built copy of a pattern that exists three other places.

        `blank` tone, not `filtered`, even for a quiet period: a business whose
        last seven days were silent is not looking at a filtered list, and the
        way out is a wider window rather than "clear your filters".
      */}
      <EmptyState
        icon={reason === "no_sources" ? Inbox : CalendarRange}
        title={t(`${reason}.title`)}
        body={t(`${reason}.body`)}
        action={
          reason === "no_sources" ? (
            <div className="flex flex-wrap justify-center gap-2">
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
            <Button asChild size="sm" variant="outline">
              <Link href={`/dashboard?range=${wider}`}>{t(`widen.${wider}`)}</Link>
            </Button>
          ) : null
        }
      />
    </Card>
  );
}
