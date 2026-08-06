import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { requireActor } from "@/auth/session";
import { schema } from "@/db/client";
import { DigestShare } from "@/components/digest/digest-share";
import { DigestView } from "@/components/digest/digest-view";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { actionCompletionRecord, digestById } from "@/digest/queries";
import { digestShareText } from "@/digest/share";
import { toShareableDigest } from "@/digest/shareable";
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
    async (tx) => {
      const digest = await digestById(tx, actor.organizationId, id);

      // Sequential, not `Promise.all`: one tenant transaction is one `pg`
      // client, which allows a single query in flight (P4-T1). The record also
      // needs this digest's period to know what to exclude.
      const record = digest
        ? await actionCompletionRecord(tx, actor.organizationId, digest.locationId, {
            before: digest.periodStart,
          })
        : null;

      const [location] = digest
        ? await tx
            .select({ name: schema.locations.name })
            .from(schema.locations)
            .where(
              and(
                eq(schema.locations.organizationId, actor.organizationId),
                eq(schema.locations.id, digest.locationId),
              ),
            )
            .limit(1)
        : [];

      return { digest, record, locationName: location?.name ?? "" };
    },
  );

  // Tenant-scoped, so another organization's id is indistinguishable from one
  // that does not exist — which is the correct answer to both.
  if (!digest) notFound();

  const inclusiveEnd = new Date(digest.periodEnd.getTime() - 1);
  const period = `${format.dateTime(digest.periodStart, {
    day: "numeric",
    month: "short",
  })} – ${format.dateTime(inclusiveEnd, { day: "numeric", month: "short", year: "numeric" })}`;

  /**
   * The shareable text is built on the server and handed to the copy button as
   * a string (W2.1).
   *
   * Not a client-side assembler: `toShareableDigest` needs a translator and a
   * locale-aware formatter, and shipping the payload plus both to the browser
   * to rebuild what the server already has would be the P3-T4 mistake — a
   * formatter across the RSC boundary — with extra bytes.
   */
  const shareText =
    digest.status === "ready"
      ? digestShareText(
          toShareableDigest({
            digest,
            scopeName: locationName,
            period,
            t,
            format: {
              number: (value, maximumFractionDigits) =>
                format.number(value, { maximumFractionDigits }),
            },
          }),
        )
      : "";

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
