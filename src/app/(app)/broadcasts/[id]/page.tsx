import { Megaphone, Users } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { BroadcastActions } from "@/components/broadcasts/broadcast-actions";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Metric } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { getBroadcast, listRecipients } from "@/broadcasts/store";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * One broadcast: what it is, what it did, and to whom (P4-T4).
 *
 * The recipients list is the honest half. A send that "went out" to two hundred
 * people while eighty of them were refused for want of consent is a different
 * event from one that reached two hundred, and a summary card alone would let
 * somebody believe the first was the second.
 */

type PageProps = { params: Promise<{ id: string }> };

export default async function BroadcastPage({ params }: PageProps) {
  const [{ id }, actor, t, format] = await Promise.all([
    params,
    requireActor(),
    getTranslations("broadcasts"),
    getFormatter(),
  ]);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      if (!(await can(org, "broadcasts"))) return null;

      const broadcast = await getBroadcast(tx, actor.organizationId, id);
      if (!broadcast) return null;

      return { broadcast, recipients: await listRecipients(tx, actor.organizationId, id) };
    },
  );

  // One 404 for "no such broadcast", "another tenant's" and "not on your plan".
  if (!data) notFound();

  const { broadcast, recipients } = data;
  const canManage = roleAtLeast(actor.role, "admin");
  const converted = recipients.filter((row) => row.converted).length;
  /** Still waiting to go out — the only state with anything to press. */
  const pending = broadcast.status === "draft" || broadcast.status === "scheduled";

  const recipientStatusLabel = {
    pending: t("recipientStatus.pending"),
    sent: t("recipientStatus.sent"),
    refused: t("recipientStatus.refused"),
    failed: t("recipientStatus.failed"),
  } as const;

  const kindLabel = {
    review_request: t("kindReviewRequest"),
    survey: t("kindSurvey"),
    message: t("kindMessage"),
  } as const;

  const channelLabel: Record<string, string> = {
    email: t("channelEmail"),
    sms: t("channelSms"),
    whatsapp: t("channelWhatsapp"),
    link: t("channelLink"),
  };

  const statusLabel = {
    draft: t("statusDraft"),
    scheduled: t("statusScheduled"),
    sending: t("statusSending"),
    sent: t("statusSent"),
    cancelled: t("statusCancelled"),
  } as const;

  return (
    <>
      <PageHeader
        title={broadcast.name}
        subtitle={`${kindLabel[broadcast.kind]} · ${channelLabel[broadcast.channel] ?? broadcast.channel}`}
        back={{ href: "/broadcasts", label: t("title") }}
        action={
          <Badge variant={broadcast.status === "sent" ? "positive" : "secondary"}>
            {statusLabel[broadcast.status]}
          </Badge>
        }
      />

      <div className="grid gap-(--grid-gap) lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start">
        <div className="flex flex-col gap-(--grid-gap)">
          <SectionCard title={t("results")} icon={Megaphone}>
            <div className="grid grid-cols-2 gap-4 pb-(--card-py) sm:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <Eyebrow>{t("audienceLabel")}</Eyebrow>
                <Metric>{broadcast.audience}</Metric>
              </div>
              <div className="flex flex-col gap-0.5">
                <Eyebrow>{t("sentLabel")}</Eyebrow>
                <Metric>{broadcast.sent}</Metric>
              </div>
              <div className="flex flex-col gap-0.5">
                <Eyebrow>{t("refusedLabel")}</Eyebrow>
                {/* Amber, not red: a refusal is the system working. */}
                <Metric tone={broadcast.refused > 0 ? "rating" : "default"}>
                  {broadcast.refused}
                </Metric>
              </div>
              <div className="flex flex-col gap-0.5">
                <Eyebrow>{t("convertedLabel")}</Eyebrow>
                <Metric>{converted}</Metric>
              </div>
            </div>
          </SectionCard>

          {broadcast.failureReason ? (
            <SectionCard title={t("abandonedTitle")} icon={Megaphone}>
              <p className="pb-(--card-py) text-body text-state-negative-text">
                {broadcast.failureReason}
              </p>
            </SectionCard>
          ) : null}

          {/*
            Only while there is something to do. A sent broadcast has no
            actions, and a card containing an empty row is worse than no card —
            it reads as a control that failed to load.
          */}
          {canManage && pending ? (
            <SectionCard title={t("actions")} icon={Megaphone}>
              <BroadcastActions broadcastId={broadcast.id} canSend canCancel />
            </SectionCard>
          ) : null}

          <SectionCard title={t("timing")} icon={Megaphone}>
            <p className="pb-(--card-py) text-body text-ink-400">
              {broadcast.finishedAt
                ? t("finishedAt", { at: format.dateTime(broadcast.finishedAt, "short") })
                : broadcast.scheduledAt
                  ? t("scheduledFor", { at: format.dateTime(broadcast.scheduledAt, "short") })
                  : t("notScheduled")}
            </p>
          </SectionCard>
        </div>

        <SectionCard title={t("recipients")} icon={Users}>
          {recipients.length === 0 ? (
            <p className="pb-(--card-py) text-body text-ink-400">{t("noRecipients")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-soft pb-(--card-py)">
              {recipients.map((row) => (
                <li
                  key={row.contactId}
                  className="flex flex-wrap items-center gap-2 py-2 first:pt-0"
                >
                  <Link
                    href={`/contacts/${row.contactId}`}
                    className="min-w-0 truncate rounded-sm text-copy font-medium text-foreground hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {row.name ?? row.email ?? t("unnamed")}
                  </Link>

                  <Badge
                    variant={
                      row.status === "sent"
                        ? "positive"
                        : row.status === "refused"
                          ? "rating"
                          : row.status === "failed"
                            ? "destructive"
                            : "secondary"
                    }
                  >
                    {recipientStatusLabel[row.status]}
                  </Badge>

                  {row.converted ? <Badge variant="accent">{t("converted")}</Badge> : null}

                  {row.refusalReason ? (
                    <span className="text-meta text-faint">
                      {REFUSALS.has(row.refusalReason)
                        ? t(`refusal.${row.refusalReason}`)
                        : row.refusalReason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}

/** The gate's vocabulary. Anything else prints as itself, so it gets noticed. */
const REFUSALS = new Set([
  "no_consent",
  "opted_out",
  "iys_not_configured",
  "iys_rejected",
  "no_open_session",
  "unknown_contact",
]);
