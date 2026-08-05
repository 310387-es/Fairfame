import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { PageHeader } from "@/components/shell/page-header";
import { ApprovalList } from "@/components/widgets/approval-list";
import { WidgetBuilder } from "@/components/widgets/widget-builder";
import { listLocationsForActor } from "@/lib/active-location";
import { requireFeature } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";
import { publicBaseUrl } from "@/lib/urls";
import { CANDIDATE_PAGE_SIZE, listDisplayCandidates } from "@/widgets/approval";
import { getWidget, listReviewSources } from "@/widgets/store";

/**
 * The widget builder page (P3-T1).
 *
 * Everything about one widget in one place: configure it, watch it change,
 * choose what it may quote, and copy the line that puts it on a website. The
 * order down the page is the order the job is done in.
 */
type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ shown?: string }>;
};

/**
 * How many candidates to load, from `?shown=`.
 *
 * In the URL rather than in client state because it changes what the *server*
 * fetches — the same rule the design system applies to the Home range. It also
 * means "show more" survives a reload, which matters when the thing you were
 * halfway through is deciding what goes on your homepage.
 */
function candidateLimit(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) return CANDIDATE_PAGE_SIZE;
  return Math.min(Math.max(value, CANDIDATE_PAGE_SIZE), 400);
}

export default async function WidgetPage({ params, searchParams }: PageProps) {
  const [{ id }, query, t, actor] = await Promise.all([
    params,
    searchParams,
    getTranslations("widgets"),
    requireActor(),
  ]);

  const limit = candidateLimit(query.shown);

  const data = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      await requireFeature({ organizationId: actor.organizationId, tx }, "widgets");

      const widget = await getWidget(tx, actor.organizationId, id);
      if (!widget) return null;

      const [locations, sources, page] = await Promise.all([
        listLocationsForActor(tx, actor),
        listReviewSources(tx, actor.organizationId),
        listDisplayCandidates(
          tx,
          {
            organizationId: actor.organizationId,
            locationId: widget.locationId,
            sources: widget.filters.sources,
          },
          widget.filters,
          { limit },
        ),
      ]);

      return { widget, locations, sources, page };
    },
  );

  // RLS already hides another tenant's widget, so this is "no such widget
  // here" rather than a permission message that would confirm one exists.
  if (!data) notFound();

  const { widget, locations, sources, page } = data;
  const canManage = roleAtLeast(actor.role, "admin");

  return (
    <>
      {/* One level deep, so the back link is the whole trail — a breadcrumb
          component would be machinery for a hierarchy that does not exist. */}
      <PageHeader
        title={widget.name}
        subtitle={t("builderSubtitle")}
        back={{ href: "/widgets", label: t("backToList") }}
      />

      <WidgetBuilder
        widgetId={widget.id}
        publicKey={widget.publicKey}
        // The origin a customer's visitors will hit, which is not necessarily
        // the one an admin is signed in to — see src/lib/urls.ts.
        embedOrigin={publicBaseUrl()}
        initialName={widget.name}
        initialLocationId={widget.locationId}
        initialFilters={widget.filters}
        initialStyle={widget.style}
        initialPublished={widget.published}
        // How many reviews are currently approved. The builder uses it only to
        // know the preview's data changed — approving a review alters what the
        // widget renders without altering a single setting.
        approvedRevision={page.approved}
        locations={locations.map(({ id: locationId, name }) => ({ id: locationId, name }))}
        sources={sources}
        canManage={canManage}
        // Handed down rather than rendered beside the builder, because whether
        // it belongs on screen depends on the layout selected in the *form* —
        // a badge quotes nothing, so there is nothing to approve for it. The
        // list is still built here, on the server: the layout in the form is
        // not the saved one, and a config the visitor has not saved yet must
        // not decide which queries the page ran.
        approvals={
          <ApprovalList
            widgetId={widget.id}
            candidates={page.candidates.map((candidate) => ({
              id: candidate.id,
              rating: candidate.rating,
              text: candidate.text,
              authorName: candidate.authorName,
              source: candidate.source,
              postedAt: candidate.postedAt?.toISOString() ?? null,
              approved: candidate.approvedAt !== null,
            }))}
            matching={page.matching}
            approved={page.approved}
            canManage={canManage}
            // Without this, a business with more matching reviews than one page
            // can hold could approve them in bulk but never withdraw one
            // individually — the takedown control simply would not exist for
            // anything past the cut.
            moreHref={
              page.candidates.length < page.matching
                ? `?shown=${limit + CANDIDATE_PAGE_SIZE}`
                : null
            }
          />
        }
      />
    </>
  );
}
