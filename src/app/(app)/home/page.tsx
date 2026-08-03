import { Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { DigestView } from "@/components/digest/digest-view";
import { GenerateDigestButton } from "@/components/digest/generate-button";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { latestDigest } from "@/digest/queries";
import {
  listLocations,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";

/**
 * Home — the weekly Action Digest.
 *
 * The design brief's first principle: "Digest is Home. The default screen
 * answers 'what happened and what should I do,' not a wall of charts."
 *
 * Nothing is generated here. The page reads one digest row and renders it, so
 * it loads like any other list — the composing happens in the worker (P1a-T7),
 * and "Generate now" queues rather than blocks.
 */
export default async function HomePage() {
  const [t, actor] = await Promise.all([getTranslations("home"), requireActor()]);
  const cookieValue = await readActiveLocationCookie();

  const { activeLocation, digest } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const locations = await listLocations(tx, actor.organizationId);
      const active = resolveActiveLocation(locations, cookieValue);

      return {
        activeLocation: active,
        digest: active ? await latestDigest(tx, actor.organizationId, active.id) : null,
      };
    },
  );

  if (!activeLocation) {
    return (
      <>
        <PageHeader title={t("title")} />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <p className="max-w-sm text-sm text-pretty text-muted-foreground">{t("noLocation")}</p>
            <Button asChild size="sm">
              <Link href="/locations">{t("noLocationAction")}</Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  // Regenerating spends the AI allowance, so the control is admin-only. The
  // server action enforces the same rule.
  const canGenerate = roleAtLeast(actor.role, "admin");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { location: activeLocation.name })}
        action={
          canGenerate ? (
            <GenerateDigestButton
              locationId={activeLocation.id}
              label={t("generate")}
              queuedLabel={t("queued")}
            />
          ) : undefined
        }
      />

      {digest ? (
        <DigestView digest={digest} />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <Sparkles className="size-6 text-muted-foreground" aria-hidden />
            <p className="font-heading text-lg font-semibold">{t("empty")}</p>
            <p className="max-w-md text-sm text-pretty text-muted-foreground">{t("emptyBody")}</p>

            {canGenerate ? (
              <div className="mt-2">
                <GenerateDigestButton
                  locationId={activeLocation.id}
                  label={t("generate")}
                  queuedLabel={t("queued")}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
