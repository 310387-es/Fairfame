"use client";

import { MapPin, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { GoogleTarget } from "@/connectors/google/mapping";
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
  const [targets, setTargets] = useState<GoogleTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    setError(null);
    startTransition(async () => {
      const result = await listGoogleTargetsAction({ connectionId });
      if (result.ok) setTargets(result.targets);
      else setError(result.error);
    });
  }

  function choose(target: GoogleTarget) {
    setError(null);
    startTransition(async () => {
      const result = await mapGoogleLocationAction({
        connectionId,
        accountId: target.accountId,
        googleLocationId: target.googleLocationId,
        title: target.title,
      });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-sm font-medium">{t("finishSetup")}</p>
      <p className="text-xs text-muted-foreground">{t("finishSetupHint")}</p>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {targets === null ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={load}>
          <RefreshCw className="size-4" aria-hidden />
          {pending ? t("loadingLocations") : t("chooseLocation")}
        </Button>
      ) : targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noGoogleLocations")}</p>
      ) : (
        <ul className="space-y-1">
          {targets.map((target) => (
            <li key={`${target.accountId}:${target.googleLocationId}`}>
              <button
                type="button"
                disabled={pending}
                onClick={() => choose(target)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{target.title}</span>
                  {target.address ? (
                    <span className="block truncate text-xs text-muted-foreground">
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
