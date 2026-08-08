"use client";

import { Link2, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import Link from "next/link";
import { GoogleMapping } from "@/components/connections/google-mapping";
import { PublicPageControl } from "@/components/locations/public-page-control";
import { VoiceSettings } from "@/components/locations/voice-settings";
import { SourceBadges } from "@/components/connections/source-badges";
import { Button } from "@/components/ui/button";
import type { SyncKind } from "@/connectors/capability-view";
import { useAction } from "@/components/ui/use-action";
import { connectSourceAction, syncNowAction } from "@/server/locations";

/**
 * What a branch's row opens into: its sources, and its public page (W4.2).
 *
 * **It was a card, and the card's top half is now the table row.** Name,
 * address, review count and a connected/not-connected badge were all rendered
 * here; they are columns now, where they can be compared against the branch
 * above. What is left is everything that is a *control* rather than a fact —
 * connect, sync, map a Google place, publish the hosted page — which is exactly
 * the part that cannot go in a table cell.
 *
 * Everything provider-specific here — the badges, whether there is a consent
 * screen to visit, whether the source can be polled at all — still comes from
 * the capability view computed on the server. The component knows about
 * capabilities; it does not know about Google.
 */

export type ConnectedSource = {
  connectionId: string;
  provider: string;
  label: string;
  status: "pending" | "active" | "error" | "disconnected";
  sync: SyncKind;
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
  /** The hosted review page (P3-T3). Null slug until it is first published. */
  publicPage: { slug: string | null; published: boolean };
  /** How this branch's replies sound and sign off (W5-12). */
  voice: { brandTone: string | null; replySignature: string | null };
};

export function LocationDetail({
  location,
  canManage,
  publicOrigin,
  approvedCount,
}: {
  location: LocationRow;
  canManage: boolean;
  /** The origin a visitor hits, which is not necessarily the dashboard's. */
  publicOrigin: string;
  /** Approved-for-display reviews in this organization; drives one warning. */
  approvedCount: number;
}) {
  const t = useTranslations("locations");
  const ts = useTranslations("sources");
  const format = useFormatter();
  // The request's shared clock, handed down by NextIntlClientProvider. Passing
  // it explicitly keeps this render identical on the server and after
  // hydration, instead of each side reading its own Date.now().
  const now = useNow();
  const { run, pending } = useAction();

  return (
    <div className="flex flex-col gap-4">
      {location.sources.length > 0 ? (
        <ul className="space-y-3">
          {location.sources.map((source) => (
            <li key={source.connectionId} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-title">{source.label}</span>
                <SourceBadges sync={source.sync} isMock={source.isMock} status={source.status} />
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
                  <Link href="/reviews">
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
                    onClick={() => run(() => syncNowAction({ connectionId: source.connectionId }))}
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

      {canManage && location.connectable.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
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

      <VoiceSettings
        locationId={location.id}
        brandTone={location.voice.brandTone}
        replySignature={location.voice.replySignature}
        canManage={canManage}
      />

      <PublicPageControl
        locationId={location.id}
        slug={location.publicPage.slug}
        published={location.publicPage.published}
        origin={publicOrigin}
        approvedCount={approvedCount}
        canManage={canManage}
      />
    </div>
  );
}
