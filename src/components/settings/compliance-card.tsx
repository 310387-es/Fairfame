import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SectionCard } from "@/components/ds/section-card";
import { Badge } from "@/components/ui/badge";
import type { ChannelStatus } from "@/channels/status";

/**
 * Why a message will not send, before anybody tries (P1-13, folded into W2.2).
 *
 * The audit's complaint was precise: a trial user hits a send-refusal and has no
 * way to find out what is missing. Every channel in this product refuses today,
 * and the reasons are spread across `IYS_REQUIRED`, `IYS_GATEWAY`,
 * `SMS_GATEWAY`, `CONNECTOR_WHATSAPP_MODE` and a WhatsApp Business Account
 * somebody has to apply for. None of that is discoverable from a failed send.
 *
 * **It leads with İYS, not with the channels**, because that is the one that
 * surprises people: WhatsApp can be perfectly connected and every commercial
 * message still refused. It is also the one nobody expects to be a *product*
 * requirement rather than a legal footnote — in Türkiye, sending a commercial
 * message to somebody whose permission is not in the national registry is the
 * fineable act, whether or not they said yes to your form.
 *
 * **Plain Turkish, not a status table.** The reader is a café owner, not an
 * operator; "IYS_GATEWAY=none" is the diagnostic and the sentence above it is
 * the answer. The environment variable is named anyway, in small type, because
 * the person who *can* fix it needs the exact string to search for.
 */
export async function ComplianceCard({ statuses }: { statuses: ChannelStatus[] }) {
  const t = await getTranslations("compliance");

  // One İYS answer for the whole deployment, so it is stated once rather than
  // repeated under every channel as if they could differ.
  const registryBlocked = statuses.some((status) =>
    status.blockers.includes("no_consent_registry"),
  );

  return (
    <SectionCard title={t("title")} icon={ShieldCheck} id="compliance">
      <p className="text-body text-pretty text-ink-400">{t("intro")}</p>

      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Badge variant={registryBlocked ? "secondary" : "positive"}>
            {t(registryBlocked ? "iysMissing" : "iysReady")}
          </Badge>
          <span className="text-body font-medium">{t("iysTitle")}</span>
        </div>
        <p className="text-body text-pretty text-ink-400">
          {t(registryBlocked ? "iysMissingBody" : "iysReadyBody")}
        </p>
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {statuses.map((status) => (
          <li key={status.descriptor.key} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant={status.deliverable ? "positive" : "secondary"}>
                {t(`mode.${status.mode}`)}
              </Badge>
              <span className="text-body font-medium">{status.descriptor.label}</span>
            </div>

            <p className="text-body text-pretty text-ink-400">
              {t(`channelState.${status.descriptor.key}.${status.mode}`)}
            </p>

            {/* The variable, for whoever can actually change it. Small, and
                last: it is a pointer for one reader and noise for the other. */}
            <p className="font-mono text-meta text-faint">{status.descriptor.envVar}</p>
          </li>
        ))}
      </ul>

      {/*
        The one thing this card must never do is imply a workaround. There is no
        "send anyway", and the sentence says the refusal is the product working.
      */}
      <p className="mt-4 text-copy text-pretty text-faint">{t("footer")}</p>
    </SectionCard>
  );
}
