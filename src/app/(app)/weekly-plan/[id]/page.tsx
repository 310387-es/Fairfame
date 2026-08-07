import { CircleAlert, Loader } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/auth/session";
import { DigestShare } from "@/components/digest/digest-share";
import { DigestView } from "@/components/digest/digest-view";
import { EmptyState } from "@/components/ds/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { describeDigest, loadDigestBundle } from "@/digest/page-data";
import { withTenant } from "@/lib/tenancy";

/**
 * One week's briefing in full (D2 — docs/14-digest-surfaces.md).
 *
 * This is where `DigestView`, `PulseTile` and `ActionCard` live now. They were
 * built for Home, orphaned when Home became a live dashboard, and are rendered
 * here unchanged — the components were never the problem, the surface was.
 *
 * Marking an action done still works from here, which is what actually closes
 * the loop: `setDigestActionStatusAction` writes the status and the next
 * digest's pipeline reads it.
 */
export default async function DigestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [t, format, actor, { id }] = await Promise.all([
    getTranslations("digest"),
    getFormatter(),
    requireActor(),
    params,
  ]);

  const { digest, record, locationName } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    (tx) => loadDigestBundle(tx, actor.organizationId, id),
  );

  // Tenant-scoped, so another organization's id is indistinguishable from one
  // that does not exist — which is the correct answer to both.
  if (!digest) notFound();

  const { period, shareText } = describeDigest({
    digest,
    locationName,
    t,
    formatDate: (value, options) => format.dateTime(value, options),
    formatNumber: (value, maximumFractionDigits) => format.number(value, { maximumFractionDigits }),
  });

  return (
    <>
      <PageHeader
        title={t("detailTitle", { period })}
        back={{ href: "/weekly-plan", label: t("backToArchive") }}
        action={
          digest.status === "ready" ? (
            <DigestShare digestId={digest.id} shareText={shareText} />
          ) : null
        }
      />

      {digest.status === "ready" ? (
        <DigestView digest={digest} record={record} />
      ) : (
        // A pending or failed week is reachable on purpose — see `digestById`.
        // Saying which of the two it is beats a 404 that implies the week never
        // existed.
        <Card>
          <EmptyState
            tone="filtered"
            icon={digest.status === "pending" ? Loader : CircleAlert}
            title={t(digest.status === "pending" ? "detailPending" : "detailFailed")}
          />
        </Card>
      )}
    </>
  );
}
