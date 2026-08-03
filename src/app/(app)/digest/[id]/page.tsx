import { ArrowLeft } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActor } from "@/auth/session";
import { DigestView } from "@/components/digest/digest-view";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { digestById } from "@/digest/queries";
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

  const digest = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    (tx) => digestById(tx, actor.organizationId, id),
  );

  // Tenant-scoped, so another organization's id is indistinguishable from one
  // that does not exist — which is the correct answer to both.
  if (!digest) notFound();

  const inclusiveEnd = new Date(digest.periodEnd.getTime() - 1);
  const period = `${format.dateTime(digest.periodStart, {
    day: "numeric",
    month: "short",
  })} – ${format.dateTime(inclusiveEnd, { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <>
      <PageHeader
        title={t("detailTitle", { period })}
        action={
          <Link
            href="/digest"
            className="flex items-center gap-1.5 rounded-sm text-copy text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t("backToArchive")}
          </Link>
        }
      />

      {digest.status === "ready" ? (
        <DigestView digest={digest} />
      ) : (
        // A pending or failed week is reachable on purpose — see `digestById`.
        // Saying which of the two it is beats a 404 that implies the week never
        // existed.
        <Card>
          <CardContent className="py-14 text-center">
            <p className="mx-auto max-w-sm text-body text-pretty text-muted-foreground">
              {t(digest.status === "pending" ? "detailPending" : "detailFailed")}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
