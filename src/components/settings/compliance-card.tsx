import { Radio } from "lucide-react";
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
 * **It used to lead with İYS and no longer does.** That was right while this
 * was a card on Settings and it is wrong now: the İYS state moved to the top of
 * `/compliance`, where it is stated once with real numbers behind it, and this
 * card sits directly underneath. Saying it twice, one card apart, is exactly
 * the confusion the page was made to end. What is left is the per-channel half
 * — the question only this card can answer, which is which of them would
 * actually deliver.
 *
 * **Plain Turkish, not a status table.** The reader is a café owner, not an
 * operator; "IYS_GATEWAY=none" is the diagnostic and the sentence above it is
 * the answer. The environment variable is named anyway, in small type, because
 * the person who *can* fix it needs the exact string to search for.
 */
export async function ComplianceCard({ statuses }: { statuses: ChannelStatus[] }) {
  const t = await getTranslations("compliance");

  return (
    <SectionCard title={t("channelsTitle")} icon={Radio} id="compliance">
      <p className="text-body text-pretty text-ink-400">{t("channelsIntro")}</p>

      <ul className="mt-4 flex flex-col gap-3">
        {statuses.map((status) => (
          <li key={status.descriptor.key} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium">{status.descriptor.label}</span>
              <Badge variant={status.deliverable ? "positive" : "secondary"}>
                {t(`mode.${status.mode}`)}
              </Badge>
            </div>

            <p className="text-body text-pretty text-ink-400">
              {t(`channelState.${status.descriptor.key}.${status.mode}`)}
            </p>

            {/*
              The environment variable's name used to print here, in monospace,
              on the theory that it was "a pointer for one reader and noise for
              the other". Removed 7 Aug 2026, because on inspection it was noise
              for both.

              Every other sentence in this card is written for a business owner
              — "Before any message reaches a customer, Turkish law requires
              their permission to be on record in İYS" — and `SMS_GATEWAY` in
              monospace underneath that is the one line addressed to somebody
              else. It reads as a leak, which is what makes an otherwise careful
              screen feel like an internal tool.

              And it did not serve the operator either: it printed the variable's
              *name* and never its *value*, so it said nothing the status chip
              above it had not already said. Somebody who can change it knows the
              name from `.env.example`; what they want is `pnpm golive`, which
              reports the resolved configuration and is the tool for this job.

              `envVar` is still rendered on `/channels`, and correctly — there it
              sits inside a sentence with a verb ("Set {envVar}, or connect an
              account"), which is instruction rather than a label.
            */}
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
