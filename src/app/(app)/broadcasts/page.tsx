import { Megaphone } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { resolveLocationScope } from "@/auth/scope";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { BroadcastForm } from "@/components/broadcasts/broadcast-form";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { SectionTabs } from "@/components/shell/section-tabs";
import { ResourcePage } from "@/components/ds/resource-page";
import { Badge } from "@/components/ui/badge";
import { TEMPLATES } from "@/connectors/whatsapp/templates";
import { listBroadcasts } from "@/broadcasts/store";
import { listSegments } from "@/contacts/segments";
import { listReviewCampaigns, listSurveys } from "@/surveys/store";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * Broadcasts (P4-T4).
 *
 * `docs/20` calls these campaigns; the product has meant something else by that
 * word since P1b-T1 — the collection strategy behind `/get-reviews`, with its own
 * hosted page and QR code — so the screen is named for what it does. See the
 * schema note on `broadcasts`.
 *
 * The list leads with what each send *achieved*, because "we ran a campaign"
 * and "we reached 214 people, 48 could not be messaged" are different amounts
 * of information and only the second is worth opening a page for.
 */
export default async function BroadcastsPage() {
  const [actor, t, format] = await Promise.all([
    requireActor(),
    getTranslations("broadcasts"),
    getFormatter(),
  ]);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };
      if (!(await can(org, "broadcasts"))) return { unlocked: false as const };

      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);

      return {
        unlocked: true as const,
        broadcasts: await listBroadcasts(tx, actor.organizationId),
        segments: await listSegments(tx, actor.organizationId),
        campaigns: await listReviewCampaigns(tx, actor.organizationId, scope),
        surveys: await listSurveys(tx, actor.organizationId, scope),
      };
    },
  );

  if (!data.unlocked) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionTabs active="broadcasts" />
        <SectionCard title={t("locked.title")} icon={Megaphone}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("locked.body")}</p>
        </SectionCard>
      </>
    );
  }

  const { broadcasts, segments, campaigns, surveys } = data;
  const canManage = roleAtLeast(actor.role, "admin");

  // Literal keys rather than `t(`kind_${row.kind}`)`. Two reasons: the i18n
  // checker only understands dot-namespaced dynamic prefixes, so an
  // underscore-joined one reads as dead — and a lookup is greppable, which a
  // concatenated key never is.
  const kindLabel = {
    review_request: t("kindReviewRequest"),
    survey: t("kindSurvey"),
    message: t("kindMessage"),
  } as const;

  const statusLabel = {
    draft: t("statusDraft"),
    scheduled: t("statusScheduled"),
    sending: t("statusSending"),
    sent: t("statusSent"),
    cancelled: t("statusCancelled"),
  } as const;

  /**
   * Three boxes became one (W1.7).
   *
   * This screen used to render an "empty" card, *and* a permanently-open "New
   * broadcast" card, *and* — inside that — a paragraph explaining you had to
   * save a segment first. Three ways of saying "there is nothing here yet", one
   * of which was an eleven-control form.
   *
   * The missing audience is now a `blocked` reason rather than a second card,
   * so the screen says the one thing that has to happen next and says it once.
   */
  const create = !canManage
    ? null
    : segments.length === 0
      ? { blocked: t("noSegments") }
      : {
          label: t("newBroadcast"),
          title: t("newBroadcast"),
          description: t("empty.body"),
          form: (
            <BroadcastForm
              segments={segments.map(({ id, name }) => ({ id, name }))}
              campaigns={campaigns.map(({ id, name }) => ({ id, name }))}
              surveys={surveys
                .filter((survey) => survey.status === "active")
                .map(({ id, name }) => ({ id, name }))}
              templates={Object.values(TEMPLATES).map((template) => ({
                name: template.name,
                variables: [...template.variables],
              }))}
            />
          ),
        };

  return (
    <>
      {/*
        Into `ResourcePage`'s `tabs` slot, which renders them *under* the page
        header — the placement `/locations`, `/connections` and `/contacts`
        already use.

        These three had them above the header instead, on the reasoning that a
        tab strip switches section while the header describes the page. That is
        true and it is not what the reader sees: above the title, the strip
        reads as chrome the title hangs off, and the page's own name comes
        second on its own screen.

        What settles it is that this file already did both. The locked-plan
        branch a few lines up renders `PageHeader` then `SectionTabs`, so the
        tab strip moved up or down the page depending on the organization's
        entitlement — the same screen, two layouts, decided by billing.
      */}
      <ResourcePage
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Megaphone}
        tabs={<SectionTabs active="broadcasts" />}
        isEmpty={broadcasts.length === 0}
        empty={{ line: t("empty.title"), hint: t("empty.body") }}
        create={create}
      >
        <ul className="divide-y divide-line-soft rounded-lg border border-line bg-card">
          {broadcasts.map((row) => (
            <li key={row.id}>
              <Link
                href={`/broadcasts/${row.id}`}
                className="grid gap-1.5 px-(--card-px) py-3 transition-colors hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center sm:gap-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-copy font-semibold text-foreground">
                    {row.name}
                  </span>
                  <Badge variant={row.status === "sent" ? "positive" : "secondary"}>
                    {statusLabel[row.status]}
                  </Badge>
                </div>

                <p className="truncate text-meta text-ink-400">
                  {kindLabel[row.kind]} · {row.segmentName ?? t("segmentGone")}
                </p>

                <p className="text-meta whitespace-nowrap text-faint sm:text-right">
                  {row.status === "sent"
                    ? t("resultLine", {
                        sent: row.sent,
                        refused: row.refused,
                        failed: row.failed,
                      })
                    : row.scheduledAt
                      ? t("scheduledFor", { at: format.dateTime(row.scheduledAt, "short") })
                      : t("notScheduled")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </ResourcePage>
    </>
  );
}
