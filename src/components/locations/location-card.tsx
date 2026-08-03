"use client";

import { Link2, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import Link from "next/link";
import { useState, useTransition } from "react";
import { GoogleMapping } from "@/components/connections/google-mapping";
import { SourceBadges } from "@/components/connections/source-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ReplyAffordance, SyncKind } from "@/connectors/capability-view";
import { connectSourceAction, syncNowAction } from "@/server/locations";

/**
 * A location and its sources.
 *
 * Everything provider-specific on this card — the badges, whether there is a
 * consent screen to visit, whether the source can be polled at all — comes from
 * the capability view computed on the server. The component knows about
 * capabilities; it does not know about Google.
 */

export type ConnectedSource = {
  connectionId: string;
  provider: string;
  label: string;
  status: "pending" | "active" | "error" | "disconnected";
  sync: SyncKind;
  reply: ReplyAffordance;
  isMock: boolean;
  /** Authorized but not yet pointed at a place on the platform. */
  needsSetup: boolean;
  /** ISO strings: this crosses the server/client boundary. */
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  failureCount: number;
  lastError: string | null;
};

export type ConnectableSource = {
  provider: string;
  label: string;
  sync: SyncKind;
  reply: ReplyAffordance;
  isMock: boolean;
  /** True when the provider is live and the flow starts at its consent screen. */
  canAuthorize: boolean;
  modeReason?: "missing_credentials" | "missing_vault";
  goLiveNote?: string;
};

export type LocationRow = {
  id: string;
  name: string;
  address: string | null;
  category: string | null;
  reviewCount: number;
  sources: ConnectedSource[];
  connectable: ConnectableSource[];
};

export function LocationCard({
  location,
  canManage,
}: {
  location: LocationRow;
  canManage: boolean;
}) {
  const t = useTranslations("locations");
  const ts = useTranslations("sources");
  const format = useFormatter();
  // The request's shared clock, handed down by NextIntlClientProvider. Passing
  // it explicitly keeps this render identical on the server and after
  // hydration, instead of each side reading its own Date.now().
  const now = useNow();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? null);
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{location.name}</p>
            {location.address ? (
              <p className="truncate text-body text-muted-foreground">{location.address}</p>
            ) : null}
          </div>
          {/* "Connected" is a reading, not a control, so it takes the positive
              pair rather than the indigo `default` — indigo means "this is
              interactive" everywhere else (docs/15 §Colour). */}
          <Badge variant={location.sources.length > 0 ? "positive" : "secondary"}>
            {location.sources.length > 0 ? t("connected") : t("notConnected")}
          </Badge>
        </div>

        <p className="text-body text-muted-foreground">
          {t("reviewCount", { count: location.reviewCount })}
        </p>

        {location.sources.length > 0 ? (
          <ul className="space-y-3 border-t pt-4">
            {location.sources.map((source) => (
              <li key={source.connectionId} className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-title">{source.label}</span>
                  <SourceBadges
                    sync={source.sync}
                    reply={source.reply}
                    isMock={source.isMock}
                    status={source.status}
                  />
                </div>

                <p className="text-copy text-muted-foreground">
                  {source.lastSyncedAt
                    ? ts("lastSynced", {
                        when: format.relativeTime(new Date(source.lastSyncedAt), now),
                      })
                    : ts("neverSynced")}
                  {/* Only worth surfacing while a backoff is actually pending. */}
                  {source.failureCount > 0 && source.nextSyncAt ? ` · ${ts("backingOff")}` : null}
                </p>

                {source.lastError && source.status === "error" ? (
                  <p className="text-copy text-destructive">{source.lastError}</p>
                ) : null}

                {/* Mapping is the one genuinely provider-shaped step: "which of
                    your places is this?" has no generic form. Everything else
                    on this card is driven by capabilities alone. */}
                {source.needsSetup && source.provider === "google" && canManage ? (
                  <GoogleMapping connectionId={source.connectionId} />
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/inbox">
                      <MessageSquare className="size-4" aria-hidden />
                      {t("viewInbox")}
                    </Link>
                  </Button>
                  {/* A source that cannot be read has nothing to pull. */}
                  {source.sync !== "outbound" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        run(() => syncNowAction({ connectionId: source.connectionId }))
                      }
                    >
                      <RefreshCw className="size-4" aria-hidden />
                      {pending ? t("syncing") : t("syncNow")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}

        {canManage && location.connectable.length > 0 ? (
          <div className="flex flex-col gap-2 border-t pt-4">
            {location.connectable.map((source) => (
              <div key={source.provider} className="flex flex-wrap items-center gap-2">
                {source.canAuthorize ? (
                  // A live provider starts at its own consent screen, so this is
                  // a plain navigation rather than a server action.
                  <Button asChild size="sm">
                    <a href={`/api/connect/${source.provider}/start?locationId=${location.id}`}>
                      <ShieldCheck className="size-4" aria-hidden />
                      {ts("connectLive", { provider: source.label })}
                    </a>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        connectSourceAction({
                          locationId: location.id,
                          provider: source.provider,
                        }),
                      )
                    }
                  >
                    <Link2 className="size-4" aria-hidden />
                    {pending ? t("connecting") : ts("connectLive", { provider: source.label })}
                  </Button>
                )}

                {source.isMock ? (
                  <span className="text-copy text-muted-foreground">
                    {ts("notLiveYet")}
                    {source.modeReason === "missing_credentials"
                      ? ` ${ts("missingCredentials")}`
                      : null}
                    {source.modeReason === "missing_vault" ? ` ${ts("missingVault")}` : null}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
