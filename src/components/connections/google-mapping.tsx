"use client";

import { MapPin, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { GoogleTarget } from "@/connectors/google/mapping";
import { useAction } from "@/components/ui/use-action";
import { listGoogleTargetsAction, mapGoogleLocationAction } from "@/server/google";

/**
 * Choosing which Google business location a connection syncs.
 *
 * Provider-specific by necessity — "which of your places is this?" has no
 * generic form, and the alternative (silently taking the first location the
 * account administers) would quietly pipe another shop's reviews into this
 * location's inbox.
 *
 * The list is fetched on demand rather than at page load: it costs two Google
 * API calls against a tight quota, and most renders of the Locations page are
 * not someone finishing a setup.
 */
export function GoogleMapping({ connectionId }: { connectionId: string }) {
  const t = useTranslations("sources");
  const tf = useTranslations("feedback");
  const [targets, setTargets] = useState<GoogleTarget[] | null>(null);
  const { run, pending } = useAction();

  function load() {
    // No success toast: the list appearing *is* the confirmation.
    run(() => listGoogleTargetsAction({ connectionId }), {
      onSuccess: (result) => setTargets(result?.targets ?? []),
    });
  }

  function choose(target: GoogleTarget) {
    run(
      () =>
        mapGoogleLocationAction({
          connectionId,
          accountId: target.accountId,
          googleLocationId: target.googleLocationId,
          title: target.title,
        }),
      { success: tf("saved") },
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-title">{t("finishSetup")}</p>
      <p className="text-copy text-muted-foreground">{t("finishSetupHint")}</p>

      {targets === null ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={load}>
          <RefreshCw className="size-4" aria-hidden />
          {pending ? t("loadingLocations") : t("chooseLocation")}
        </Button>
      ) : targets.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("noGoogleLocations")}</p>
      ) : (
        <ul className="space-y-1">
          {targets.map((target) => (
            <li key={`${target.accountId}:${target.googleLocationId}`}>
              <button
                type="button"
                disabled={pending}
                onClick={() => choose(target)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-body transition-colors hover:bg-accent disabled:opacity-50"
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{target.title}</span>
                  {target.address ? (
                    <span className="block truncate text-copy text-muted-foreground">
                      {target.address}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
