import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { requireActor } from "@/auth/session";
import { listReviewsForLocation } from "@/connectors/normalize";
import { ReviewList, type InboxReview } from "@/components/inbox/review-list";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  listLocations,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * The Inbox — every ingested review for the active location, newest first.
 *
 * This is the end of the Phase 0 slice: reviews here arrived through the
 * Connector interface into the canonical table, and are visible only because
 * the tenant context allows it.
 */
export default async function InboxPage() {
  const [t, actor] = await Promise.all([getTranslations("inbox"), requireActor()]);

  const cookieValue = await readActiveLocationCookie();

  const { locations, reviews, activeLocation } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const locations = await listLocations(tx, actor.organizationId);
      const activeLocation = resolveActiveLocation(locations, cookieValue);

      const reviews = activeLocation
        ? await listReviewsForLocation(tx, actor.organizationId, activeLocation.id, 100)
        : [];

      return { locations, activeLocation, reviews };
    },
  );

  const items: InboxReview[] = reviews.map((review) => ({
    id: review.id,
    authorName: review.authorName,
    rating: review.rating,
    text: review.text,
    language: review.language,
    postedAt: review.postedAt,
    source: review.source,
    // The provider payload is retained verbatim, so an owner reply is
    // discoverable even before replies get their own table.
    hasOwnerReply:
      typeof review.rawPayload === "object" &&
      review.rawPayload !== null &&
      "ownerReply" in review.rawPayload,
  }));

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={
          activeLocation ? t("forLocation", { location: activeLocation.name }) : t("subtitle")
        }
      />

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <p className="max-w-sm text-sm text-pretty text-muted-foreground">
              {locations.length === 0 ? t("empty") : t("noLocationSelected")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/locations">{t("emptyAction")}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("count", { count: items.length })}
          </p>
          <ReviewList reviews={items} />
        </>
      )}
    </>
  );
}
