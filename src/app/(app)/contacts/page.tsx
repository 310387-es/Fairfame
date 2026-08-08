import { Users } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { resolveLocationScope } from "@/auth/scope";
import { requireActor } from "@/auth/session";
import { roleAtLeast } from "@/auth/permissions";
import { ContactFilterBar } from "@/components/contacts/contact-filter-bar";
import { ContactList, type ContactListRow } from "@/components/contacts/contact-list";
import { SegmentRow, type SegmentChip } from "@/components/contacts/segment-row";
import { Pager } from "@/components/ds/pager";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { SectionTabs } from "@/components/shell/section-tabs";
import {
  contactFilterParams,
  contactsHref,
  hasActiveContactFilters,
  parseContactFilters,
  parseContactPage,
  type RawParams,
} from "@/contacts/filters";
import { countContacts, listContacts, CONTACTS_PAGE_SIZE } from "@/contacts/queries";
import { listSegments } from "@/contacts/segments";
import { listContactTags } from "@/contacts/tags";
import { listLocationsForActor } from "@/lib/active-location";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * Contacts — the light CRM (P4-T1).
 *
 * The screen a business opens to ask "who are our customers, and what has
 * happened with them". Everything narrowing the list is in the URL, which is
 * what makes a **segment** — a saved audience P4-T4 will send campaigns to —
 * nothing more than this query string with a name on it.
 *
 * **Location scope is the load-bearing part.** `contacts` has no `location_id`,
 * so RLS stops another tenant and has nothing to say about a member pinned to
 * one branch. The scope resolved here is passed into every read and interpreted
 * in exactly one place (`src/contacts/scope.ts`), where an empty scope returns
 * nothing rather than everything — the failure mode that looks perfect to the
 * admin testing it and is a leak for the member it was meant to restrict.
 */

type PageProps = { searchParams: Promise<RawParams> };

export default async function ContactsPage({ searchParams }: PageProps) {
  const [params, actor, t, format] = await Promise.all([
    searchParams,
    requireActor(),
    getTranslations("contacts"),
    getFormatter(),
  ]);

  const filters = parseContactFilters(params);
  const requestedPage = parseContactPage(params);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const org = { organizationId: actor.organizationId, tx };

      // Read as a locked card rather than a redirect, on the P3-T7 precedent:
      // "not on your plan" is information, and a bounce to Home is a mystery.
      if (!(await can(org, "crm"))) return { unlocked: false as const };

      const scope = await resolveLocationScope(tx, actor.organizationId, actor.userId, actor.role);

      const segments = await listSegments(tx, actor.organizationId);

      // One count per segment, and the same scope the list itself uses — a chip
      // promising 214 people to somebody who may only see one branch would be a
      // number they cannot act on. Bounded by MAX_SEGMENTS.
      //
      // A loop rather than `Promise.all`: every query in this block shares one
      // `pg` client inside the tenant transaction, and that client can only
      // have one query in flight. Overlapping them is deprecated in pg@8 and an
      // error in pg@9 — the concurrency was never real, only the risk was.
      const segmentCounts: number[] = [];
      for (const segment of segments) {
        segmentCounts.push(
          await countContacts({
            tx,
            organizationId: actor.organizationId,
            scope,
            filters: segment.filters,
          }),
        );
      }

      return {
        unlocked: true as const,
        locations: await listLocationsForActor(tx, actor),
        tags: await listContactTags(tx, actor.organizationId),
        page: await listContacts({
          tx,
          organizationId: actor.organizationId,
          scope,
          filters,
          page: requestedPage,
        }),
        segments,
        segmentCounts,
      };
    },
  );

  if (!data.unlocked) {
    return (
      <>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <SectionTabs active="contacts" />
        <SectionCard title={t("locked.title")} icon={Users}>
          <p className="pb-(--card-py) text-body text-ink-400">{t("locked.body")}</p>
        </SectionCard>
      </>
    );
  }

  const { page, tags, segments, segmentCounts, locations } = data;
  const now = new Date();

  const rows: ContactListRow[] = page.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    unsubscribed: row.unsubscribedAt !== null,
    tags: row.tags,
    reviewCount: row.reviewCount,
    emailConsent: row.emailConsent,
    messageConsent: row.messageConsent,
    // Formatted here, on the server. A formatter cannot cross the RSC boundary.
    lastActivity: row.lastActivityAt ? format.relativeTime(row.lastActivityAt, now) : null,
  }));

  const segmentChips: SegmentChip[] = segments.map((segment, index) => ({
    id: segment.id,
    name: segment.name,
    href: segment.href,
    count: segmentCounts[index] ?? 0,
  }));

  const currentQuery = contactFilterParams(filters).toString();
  const filtered = hasActiveContactFilters(filters);
  const first = (page.page - 1) * CONTACTS_PAGE_SIZE;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SectionTabs active="contacts" />

      <SegmentRow
        segments={segmentChips}
        currentQuery={currentQuery}
        canManage={roleAtLeast(actor.role, "admin")}
        canSave={filtered}
      />

      <ContactFilterBar filters={filters} tags={tags} locations={locations} />

      {page.total === 0 ? (
        <SectionCard title={filtered ? t("empty.filteredTitle") : t("empty.title")} icon={Users}>
          <p className="pb-(--card-py) text-body text-ink-400">
            {filtered ? t("empty.filteredBody") : t("empty.body")}
          </p>
        </SectionCard>
      ) : (
        <>
          <ContactList
            rows={rows}
            labels={{
              unnamed: t("unnamed"),
              unsubscribed: t("unsubscribed"),
              reviews: (count) => t("reviewCount", { count }),
              noActivity: t("noActivity"),
              moreTags: (count) => t("moreTags", { count }),
              emailConsent: t("consentEmail"),
              messageConsent: t("consentMessage"),
            }}
          />

          <Pager
            page={page.page}
            pageCount={page.pageCount}
            hrefFor={(target) => contactsHref(filters, target)}
            label={t("pagerLabel")}
            previousLabel={t("previous")}
            nextLabel={t("next")}
            status={t("pagerStatus", {
              from: first + 1,
              to: first + page.rows.length,
              total: page.total,
            })}
          />
        </>
      )}
    </>
  );
}
