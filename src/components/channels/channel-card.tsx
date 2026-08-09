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
            /**
             * **"Bağla" promised something this cannot do** (A22-B4).
             *
             * Connecting genuinely works — a row is written, the mock client
             * answers, a conversation round-trips — and no message reaches a
             * phone, because no channel in this product is live. A button
             * reading "Connect" over that is the same lie A22-B2 fixed on the
             * sources screen, and it is worse here: the thing being connected
             * is permission to write to customers.
             *
             * **Relabelled rather than disabled**, deliberately. Disabling it
             * would leave a pre-go-live deployment — which is every deployment
             * — with no way to exercise the messaging path at all, and the
             * blockers listed below already say exactly what is missing and
             * whose job each one is. Same trade as the campaign form's channel
             * picker: offer it, and say what it is.
             */
            <Button
              type="button"
              size="sm"
              variant={mode === "live" ? "default" : "outline"}
              disabled={pending || mode === "off"}
              onClick={() =>
                void run(() => connectChannelAction({ channel }), {
                  success: t("connected", { label }),
                })
              }
            >
              {mode === "live" ? t("connect") : t("tryInSample")}
            </Button>
          )
        ) : null
      }
    >
      {/*
        The connected account's own name — "Kadıköy Kahve", the WhatsApp
        Business profile somebody actually linked. Worth a line, because it is
        the one thing on this card that says *which* account, and a business
        with two of them cannot tell otherwise.

        Suppressed when it merely restates the channel, which is what the mock
        does: `createMockWhatsAppClient` names its account "WhatsApp Business
        (mock)", so the card rendered "WhatsApp Business" as its title and
        "WhatsApp Business (mock)" as its first body line, directly underneath.
        A real account could collide the same way — plenty of businesses name
        their profile after the product — so this is a guard rather than a
        mock-only special case.

        `startsWith` on the label, not equality: the collision is a prefix
        ("WhatsApp Business" inside "WhatsApp Business (mock)"), and the mode is
        already shown as the card's `meta`.
      */}
      {displayName && !displayName.startsWith(label) ? (
        <p className="mb-3 text-body">{displayName}</p>
      ) : null}

      {blockers.length === 0 ? (
        <p className="text-body text-state-positive-text">{t("ready")}</p>
      ) : (
        /*
          A two-column list, not a flex row per blocker.

          The chips are labels of different lengths — "Not connected", "No İYS
          registry", "Not live" — so a flex row started each explanation at a
          different x, and a card with three blockers read as a ragged staircase
          rather than a list of three comparable facts. A grid with one shared
          label column puts every sentence on the same left edge, which is the
          whole reason the chips exist: they are a key down the side, and a key
          that does not line up is just decoration.

          `items-baseline` rather than `items-start`: a 10px chip and 14px prose
          aligned by box top sit visibly off each other.
        */
        <ul className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">
          {blockers.map((blocker) => (
            <li key={blocker} className="col-span-2 grid grid-cols-subgrid items-baseline">
              <Badge variant={blocker === "connection_error" ? "negative" : "secondary"}>
                {t(`blockerLabel.${blocker}`)}
              </Badge>
              <span className="min-w-0 text-body leading-relaxed text-pretty text-muted-foreground">
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
