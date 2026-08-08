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
        {/*
          The name first, its state after.

          Chip-then-name put three labels of different widths in front of three
          titles, so "İYS", "WhatsApp Business" and "SMS" each began at a
          different x and the list read as a staircase — which is the same
          defect the blocker list on `/channels` had. Reversing it is better
          than aligning it: the names are what somebody scans down, and the
          state is an annotation on each. It also matches the card header on
          `/channels` and the rows on `/locations`, which have always read
          name-then-state.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium">{t("iysTitle")}</span>
          <Badge variant={registryBlocked ? "secondary" : "positive"}>
            {t(registryBlocked ? "iysMissing" : "iysReady")}
          </Badge>
        </div>
        <p className="text-body text-pretty text-ink-400">
          {t(registryBlocked ? "iysMissingBody" : "iysReadyBody")}
        </p>
      </div>

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
