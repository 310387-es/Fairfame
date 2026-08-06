"use client";

import { Link2Off, MessageCircle, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { connectChannelAction, disconnectChannelAction } from "@/server/channels";

/**
 * One messaging channel, and whether it can carry anything (W2.2).
 *
 * **The card leads with the blockers, not with a green tick.** Every channel in
 * this product is mock-only today, and a status card that said "Connected" over
 * a channel that has never reached a phone would be the single most misleading
 * thing on any screen — a business would schedule a campaign on it. So the
 * blockers are listed, each one named, and the connect button is only the
 * answer to *one* of them.
 *
 * The blockers have different owners, which is why they are separate lines
 * rather than one verdict: the business connects WhatsApp, whoever runs the
 * installation chooses the SMS gateway and the İYS registry, and the company
 * signs the BSP contract. "Not ready" alone would send all three to each other.
 */

type Blocker = "not_connected" | "connection_error" | "no_consent_registry" | "not_live";

export function ChannelCard({
  channel,
  label,
  provisioning,
  mode,
  blockers,
  connectionStatus,
  displayName,
  lastError,
  envVar,
  canManage,
}: {
  channel: "whatsapp" | "sms";
  label: string;
  provisioning: "connection" | "deployment";
  mode: "live" | "mock" | "off";
  blockers: Blocker[];
  connectionStatus: string | null;
  displayName: string | null;
  lastError: string | null;
  envVar: string;
  canManage: boolean;
}) {
  const t = useTranslations("channels");
  const { run, pending } = useAction();

  const connected = connectionStatus === "active";
  const Icon = channel === "whatsapp" ? MessageCircle : Smartphone;

  return (
    <SectionCard
      title={label}
      icon={Icon}
      meta={t(`mode.${mode}`)}
      action={
        // Only a channel a *business* connects gets a button. SMS is chosen by
        // whoever runs the installation, so offering "Connect" would point at
        // a screen that does not exist and a decision that is not theirs.
        provisioning === "connection" && canManage ? (
          connected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(() => disconnectChannelAction({ channel }), {
                  success: t("disconnected", { label }),
                })
              }
            >
              <Link2Off className="size-4" aria-hidden />
              {t("disconnect")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={pending || mode === "off"}
              onClick={() =>
                void run(() => connectChannelAction({ channel }), {
                  success: t("connected", { label }),
                })
              }
            >
              {t("connect")}
            </Button>
          )
        ) : null
      }
    >
      {displayName ? <p className="mb-3 text-body">{displayName}</p> : null}

      {blockers.length === 0 ? (
        <p className="text-body text-state-positive-text">{t("ready")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {blockers.map((blocker) => (
            <li key={blocker} className="flex items-start gap-2 text-body leading-relaxed">
              <Badge variant={blocker === "connection_error" ? "negative" : "secondary"}>
                {t(`blockerLabel.${blocker}`)}
              </Badge>
              <span className="min-w-0 text-pretty text-muted-foreground">
                {t(`blocker.${blocker}`, { envVar })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* The provider's own words about the last failure. Shown verbatim rather
          than translated: it is a diagnostic, and paraphrasing it would make it
          unsearchable for the person trying to fix it. */}
      {lastError ? <p className="mt-3 text-copy text-faint">{lastError}</p> : null}

      {/* The descriptor also carries this note in English, for `pnpm golive` and
          the logs. This is the customer-facing copy, and it has to be in the
          reader's language: an English sentence under a Turkish heading is the
          product telling somebody it was not built for them. */}
      {mode !== "live" ? (
        <p className="mt-3 text-copy text-faint">{t(`goLive.${channel}`)}</p>
      ) : null}
    </SectionCard>
  );
}
