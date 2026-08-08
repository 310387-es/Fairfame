import { AlertTriangle, ScrollText, ShieldCheck, UserRoundX } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { channelStatuses } from "@/channels/status";
import { ComplianceCard } from "@/components/settings/compliance-card";
import { SubjectRequests } from "@/components/compliance/subject-requests";
import { Eyebrow } from "@/components/ds/eyebrow";
import { Metric } from "@/components/ds/metric";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { SectionTabs } from "@/components/shell/section-tabs";
import { complianceOverview } from "@/compliance/overview";
import { withTenant } from "@/lib/tenancy";

/**
 * Compliance — positioning win 3 in `docs/remediation-plan.md`.
 *
 * > **Compliance page** (İYS status + KVKK tooling + the no-rating-gating
 * > statement) — then put it on the pricing page. It's the one claim a
 * > competitor can't copy in a quarter.
 *
 * Three things a competitor would each need a quarter to build, on one screen
 * so they can be pointed at:
 *
 *   1. **İYS**, with real numbers, including the ones that are unflattering.
 *      `local` acceptances are counted separately from registrations, because a
 *      development adapter accepting a permission is not the national registry
 *      holding it, and `iys_uploaded_via` exists so those two can never blur.
 *   2. **KVKK**, as a working tool rather than a promise. Export and erasure
 *      have existed since P1b-T5 and were reachable only from a contact's
 *      profile; a subject request arrives as an email with a phone number in
 *      it, so the search box takes that.
 *   3. **No review-gating**, stated plainly, with the two places in the code
 *      that make it structural rather than a policy anybody could quietly
 *      change. That is the part that is genuinely hard to copy: it is a shape,
 *      not a checkbox.
 *
 * The channel card moves here from Settings rather than being duplicated. It
 * answers "why will my message not send", which is the operational half of the
 * same subject, and İYS being explained in two places one click apart is
 * exactly the mistake this page exists to stop.
 */
export default async function CompliancePage() {
  const [t, actor] = await Promise.all([getTranslations("compliance"), requireActor()]);

  const { overview, statuses } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => ({
      overview: await complianceOverview(tx, actor.organizationId),
      statuses: await channelStatuses(tx, actor.organizationId),
    }),
  );

  const canManage = roleAtLeast(actor.role, "admin");
  const { consents } = overview;

  return (
    <>
      <PageHeader title={t("pageTitle")} subtitle={t("pageSubtitle")} />
      <SectionTabs active="compliance" />

      <SectionCard title={t("iysTitle")} icon={ShieldCheck}>
        <p className="text-body text-pretty text-ink-400">
          {t(overview.gatewayIsReal ? "registryLive" : "registryLocal", {
            gateway: overview.gateway ?? t("registryNone"),
          })}
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <Tally label={t("recorded")} value={consents.recorded} />
          {/*
            Registered is separate from recorded, and it is the number that can
            embarrass us. Until a real BSP adapter exists it is zero however
            many permissions have been captured — which is the true answer, and
            the reason `iys_uploaded_via` is on every row.
          */}
          <Tally label={t("registered")} value={consents.registered} />
          <Tally label={t("pendingUpload")} value={consents.pending} />
          <Tally
            label={t("overdue")}
            value={consents.overdue}
            tone={consents.overdue > 0 ? "negative" : "default"}
          />
        </div>

        {consents.overdue > 0 ? (
          <p className="mt-3 flex items-start gap-2 text-copy text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("overdueBody", { count: consents.overdue })}
          </p>
        ) : null}

        <p className="mt-3 text-copy text-muted-foreground">
          {t("optedOutBody", { count: consents.optedOut })}
        </p>
      </SectionCard>

      {/* The operational half: which channels would actually deliver, and what
          is stopping each. Moved from Settings — see the page comment. */}
      <ComplianceCard statuses={statuses} />

      <SectionCard title={t("gatingTitle")} icon={ScrollText}>
        <p className="text-body text-pretty text-ink-400">{t("gatingBody")}</p>
        {/*
          The two structural facts, stated for a reader rather than as code
          references. They are what makes this a shape instead of a policy: a
          survey has no review destination of its own, and the function that
          decides where a review is solicited has never been able to see a
          rating — so gating would mean changing a signature in two files, not
          adding an `if`.
        */}
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-body text-pretty text-ink-400">
          <li>{t("gatingPoint1")}</li>
          <li>{t("gatingPoint2")}</li>
          <li>{t("gatingPoint3")}</li>
        </ul>
      </SectionCard>

      <SectionCard title={t("kvkk.title")} icon={UserRoundX}>
        <p className="text-body text-pretty text-ink-400">{t("kvkk.body")}</p>

        <div className="mt-4">
          {canManage ? (
            <SubjectRequests />
          ) : (
            // A member sees that the tooling exists — it is part of the claim —
            // without a control the server would refuse.
            <p className="text-copy text-muted-foreground">{t("kvkk.adminOnly")}</p>
          )}
        </div>
      </SectionCard>
    </>
  );
}

/**
 * One figure with its name over it.
 *
 * `Metric` styles the number and nothing else, which is right — every KPI in
 * the product pairs it with its own label markup. Four in a row on one card is
 * enough repetition to be worth a local component and not enough to earn a
 * place in the design system.
 */
function Tally({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "negative";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Eyebrow>{label}</Eyebrow>
      <Metric tone={tone}>{value}</Metric>
    </div>
  );
}
