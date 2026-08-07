import { MapPin } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Suspense } from "react";
import { requireActor } from "@/auth/session";
import { Overview, OverviewSkeleton } from "@/components/dashboard/overview";
import { RangeToggle } from "@/components/dashboard/range-toggle";
import { EmptyState } from "@/components/ds/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { parseRange, rangeWindow } from "@/dashboard/range";
import { BRANCH_PARAM, resolveHomeScope } from "@/dashboard/scope";
import { listLocationsForActor } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Home — the live dashboard (docs/home-live-dashboard.md).
 *
 * It used to render the weekly Action Digest. The digest still exists and is
 * still the product's opinionated hero — its *surface* moved to email and a
 * `/weekly-plan` archive, because a briefing composed once a week is something you
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
  const [t, actor, params] = await Promise.all([
    getTranslations("home"),
    requireActor(),
    searchParams,
  ]);

  // One range for the whole page. Every widget reads this same window rather
  // than deriving its own, so no two cards can disagree about which days they
  // are describing.
  const range = parseRange(params.range);
  const window = rangeWindow(range, new Date());

  const locations = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    (tx) => listLocationsForActor(tx, actor),
  );

  /**
   * Home is scoped by its own URL, not by the global branch switcher (W4.3).
   * `src/dashboard/scope.ts` carries the reasoning, and the default is every
   * branch this member may see.
   */
  const scope = resolveHomeScope(locations, params[BRANCH_PARAM]);

  if (locations.length === 0) {
    return (
      <>
        <PageHeader title={t("overviewTitle")} />
        <Card>
          <EmptyState
            icon={MapPin}
            title={t("noLocation")}
            action={
              <Button asChild size="sm">
                <Link href="/locations">{t("noLocationAction")}</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("overviewTitle")}
        subtitle={
          scope.name === null
            ? t("overviewSubtitleAll", { count: locations.length })
            : t("overviewSubtitle", { location: scope.name })
        }
        action={<RangeToggle active={range} />}
      />

      <Suspense key={`${scope.locationId ?? "all"}:${range}`} fallback={<OverviewSkeleton />}>
        <Overview
          organizationId={actor.organizationId}
          userId={actor.userId}
          locations={locations}
          scope={scope}
          window={window}
        />
      </Suspense>
    </>
  );
}
