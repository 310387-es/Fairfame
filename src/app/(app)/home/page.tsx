import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";
import { requireActor } from "@/auth/session";
import { Overview, OverviewSkeleton } from "@/components/home/overview";
import { RangeToggle } from "@/components/home/range-toggle";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { parseRange, rangeWindow } from "@/dashboard/range";
import {
  listLocations,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Home — the live dashboard (docs/home-live-dashboard.md).
 *
 * It used to render the weekly Action Digest. The digest still exists and is
 * still the product's opinionated hero — its *surface* moved to email and a
 * `/digest` archive, because a briefing composed once a week is something you
 * open when it arrives, not the answer to "what is happening right now". Home
 * answers that instead, live and scoped to one location and one range.
 *
 * The page itself resolves only what the shell needs — who is asking, which
 * location, which window. Everything data-heavy sits behind a Suspense
 * boundary so the header and the range toggle paint immediately.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, actor] = await Promise.all([getTranslations("home"), requireActor()]);
  const [cookieValue, params] = await Promise.all([readActiveLocationCookie(), searchParams]);

  // One range for the whole page. Every widget reads this same window rather
  // than deriving its own, so no two cards can disagree about which days they
  // are describing.
  const range = parseRange(params.range);
  const window = rangeWindow(range, new Date());

  const activeLocation = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => resolveActiveLocation(await listLocations(tx, actor.organizationId), cookieValue),
  );

  if (!activeLocation) {
    return (
      <>
        <PageHeader title={t("overviewTitle")} />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <p className="max-w-sm text-body text-pretty text-muted-foreground">
              {t("noLocation")}
            </p>
            <Button asChild size="sm">
              <Link href="/locations">{t("noLocationAction")}</Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("overviewTitle")}
        subtitle={t("overviewSubtitle", { location: activeLocation.name })}
        action={<RangeToggle active={range} />}
      />

      <Suspense key={`${activeLocation.id}:${range}`} fallback={<OverviewSkeleton />}>
        <Overview
          organizationId={actor.organizationId}
          userId={actor.userId}
          locationId={activeLocation.id}
          window={window}
        />
      </Suspense>
    </>
  );
}
