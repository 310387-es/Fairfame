import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { roleAtLeast } from "@/auth/permissions";
import { assignableMembers } from "@/auth/scope";
import { requireActor } from "@/auth/session";
import { InboxFilterBar } from "@/components/inbox/filter-bar";
import { ReviewList, type InboxReview } from "@/components/inbox/review-list";
import { ScrollToReview } from "@/components/inbox/scroll-to-review";
import { Pager } from "@/components/ds/pager";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeProvider } from "@/connectors/capability-view";
import { SavedViews } from "@/components/inbox/saved-views";
import { LiveRefresh } from "@/components/inbox/live-refresh";
import { BulkBar, SelectionProvider } from "@/components/inbox/selection";
import {
  hasActiveFilters,
  inboxFilterParams,
  inboxHref,
  MAX_LOAD_MORE,
  parseInboxFilters,
  parseInboxPosition,
} from "@/inbox/filters";
import { countInbox, inboxFacets, listInbox, locateReview, toInboxFilters } from "@/inbox/queries";
import { listSavedViews } from "@/inbox/views";
import { listReplyTemplates } from "@/replies/templates";
import { slaState } from "@/inbox/workflow";
import {
  listLocationsForActor,
  readActiveLocationCookie,
  resolveActiveLocation,
} from "@/lib/active-location";
import { can } from "@/lib/entitlements";
import { withTenant } from "@/lib/tenancy";

/**
 * The Inbox — every ingested review for the active location, newest first,
 * with its analysis and its reply state.
 *
 * Filters live in the URL rather than in component state, which is what lets a
 * digest action link straight to the reviews behind it (`/inbox?theme=servis`)
 * and lets an owner share "the negative ones from Google" with a colleague.
 */

/**
 * Reviews per page.
 *
 * Twenty rather than the hundred this used to render in one go. A review card
 * carries its analysis, its chips and a reply composer, so a hundred of them is
 * a very long page to scroll and a lot of composer state to hydrate for rows
 * nobody will look at.
 */
const PAGE_SIZE = 20;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, actor, params] = await Promise.all([
    getTranslations("inbox"),
    requireActor(),
    searchParams,
  ]);

  // One clock for the whole render, so two cards cannot disagree about whether
  // the same deadline has passed.
  const now = new Date();
  const filters = parseInboxFilters(params);
  const position = parseInboxPosition(params);
  const cookieValue = await readActiveLocationCookie();

  // `?review=<id>` means "take me to this one" — from a notification, a search
  // result or Home's queue. An explicit `?page=` still wins, so paging away
  // from the review does not keep dragging you back to it.
  const wantedReview = typeof params.review === "string" ? params.review : null;

  // `me` becomes this reader's id, and the two `YYYY-MM-DD` bounds become
  // instants. Done once, so every read below asks the same question.
  const queryFilters = toInboxFilters(filters, { userId: actor.userId });

  // One page on a desktop; one page plus whatever the phone has asked for.
  // A single query either way, so the extra rows cannot disagree with the first
  // twenty about what the list contains.
  const windowSize = PAGE_SIZE * (1 + position.more);

  const {
    locations,
    page,
    matching,
    activeLocation,
    facets,
    canUseAi,
    canSaveViews,
    canBulk,
    canTrackSla,
    currentPage,
    views,
    assignees,
    templates,
  } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      // Which branches this person may see at all (P2-T4). Everything below
      // inherits the narrowing: the switcher offers fewer, and a cookie
      // pointing outside the scope falls back rather than being honoured.
      const allLocations = await listLocationsForActor(tx, actor);
      const active = resolveActiveLocation(allLocations, cookieValue);

      if (!active) {
        return {
          locations: allLocations,
          activeLocation: null,
          page: { rows: [], hasMore: false, nextCursor: null },
          matching: 0,
          facets: null,
          canUseAi: false,
          canSaveViews: false,
          canBulk: false,
          canTrackSla: false,
          currentPage: 1,
          views: [],
          assignees: [],
          templates: [],
        };
      }

      // Resolved before the list is read, because it decides which slice to read.
      const resolvedPage =
        position.page ??
        (wantedReview
          ? ((await locateReview(
              tx,
              actor.organizationId,
              active.id,
              wantedReview,
              queryFilters,
              PAGE_SIZE,
            )) ?? 1)
          : 1);

      return {
        locations: allLocations,
        activeLocation: active,
        currentPage: resolvedPage,
        page: await listInbox(tx, actor.organizationId, active.id, {
          ...queryFilters,
          limit: windowSize,
          offset: (resolvedPage - 1) * PAGE_SIZE,
        }),
        // The pager needs a real total, which the list cannot give it.
        matching: await countInbox(tx, actor.organizationId, active.id, queryFilters),
        facets: await inboxFacets(tx, actor.organizationId, active.id, { userId: actor.userId }),
        // Server-side, from plan config — never `if plan === '...'`. The
        // server refuses each of these on its own too; this only decides
        // whether to render a control that would be refused (P2-T8).
        canUseAi: await can({ organizationId: actor.organizationId, tx }, "ai_replies"),
        canSaveViews: await can({ organizationId: actor.organizationId, tx }, "saved_views"),
        canBulk: await can({ organizationId: actor.organizationId, tx }, "bulk_actions"),
        canTrackSla: await can({ organizationId: actor.organizationId, tx }, "sla_tracking"),
        views: await listSavedViews(tx, actor.organizationId, actor.userId),
        // Only people who can actually open this location: an assignee picker
        // that produces unreachable work is worse than no picker.
        assignees: await assignableMembers(tx, actor.organizationId, active.id),
        templates: await listReplyTemplates(tx, actor.organizationId),
      };
    },
  );

  const items: InboxReview[] = page.rows.map((review) => {
    // Capability comes from the source the row was ingested from, so a mixed
    // inbox offers the right action per review rather than one action for all.
    const view = describeProvider(review.source);

    return {
      id: review.id,
      authorName: review.authorName,
      rating: review.rating,
      text: review.text,
      language: review.language,
      postedAt: review.postedAt,
      source: review.source,
      sourceLabel: view?.label ?? review.source,
      reply: view?.reply ?? "none",
      url: review.url,
      sentiment: review.sentiment,
      topics: review.topics,
      status: review.status,
      assigneeUserId: review.assignee?.id ?? null,
      // Computed on the server so every card in a render agrees about "now",
      // rather than each one asking the browser a moment apart.
      // `none` renders no badge at all, which is the honest thing to show a
      // plan that does not include deadline tracking — the data is still being
      // stamped, so an upgrade reveals real history rather than starting fresh.
      sla: canTrackSla ? slaState(review, now) : ("none" as const),
      slaDueAt: canTrackSla ? review.slaDueAt : null,
      // The provider payload is retained verbatim, so an owner reply made on
      // the platform itself is discoverable even though we did not post it.
      hasOwnerReply:
        typeof review.rawPayload === "object" &&
        review.rawPayload !== null &&
        "ownerReply" in review.rawPayload,
      reply_: review.reply,
    };
  });

  const sourceLabels = Object.fromEntries(
    (facets?.sources ?? []).map((source) => [
      source.value,
      describeProvider(source.value)?.label ?? source.value,
    ]),
  );

  const filtered = hasActiveFilters(filters);

  // The phone's pager. Offered while there is more to show and the cap has not
  // been reached; past that the numbered pager takes over on every width, so the
  // reader is never stranded at the bottom of a long list with no way forward.
  const showLoadMore = page.hasMore && position.more < MAX_LOAD_MORE;

  return (
    <>
      {/* The list streams in after the browser has already given up on the URL
          fragment, so an anchored link needs this to land. */}
      <ScrollToReview />

      {/* Keeps the list current while somebody is looking at it (P2-T7).
          Renders nothing; it watches a count and soft-refreshes when it moves. */}
      {activeLocation ? (
        <LiveRefresh
          params={Object.fromEntries(inboxFilterParams(filters).entries())}
          matching={matching}
        />
      ) : null}

      <PageHeader
        title={t("title")}
        subtitle={
          activeLocation ? t("forLocation", { location: activeLocation.name }) : t("subtitle")
        }
      />

      {!activeLocation ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
            <p className="max-w-sm text-body text-pretty text-muted-foreground">
              {locations.length === 0 ? t("empty") : t("noLocationSelected")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/locations">{t("emptyAction")}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {facets && facets.total > 0 ? (
            <InboxFilterBar
              facets={facets}
              filters={filters}
              sourceLabels={sourceLabels}
              canTrackSla={canTrackSla}
            />
          ) : null}

          {canSaveViews ? (
            <SavedViews
              views={views.map((view) => ({
                id: view.id,
                name: view.name,
                shared: view.shared,
                href: view.href,
              }))}
              currentParams={Object.fromEntries(inboxFilterParams(filters).entries())}
              currentQuery={inboxFilterParams(filters).toString()}
              // Saving is server-enforced too; this only decides whether to offer
              // a control that would be refused.
              canShare={roleAtLeast(actor.role, "admin")}
              // Nothing filtered is nothing worth naming — "the whole inbox" is
              // already one click away.
              canSave={filtered}
            />
          ) : null}

          <p className="text-body text-muted-foreground">
            {/*
              Two different truths, said differently: a filtered list and the
              whole thing. The count is now exact in both cases — the pager
              below carries "which slice of it you are looking at", so this line
              no longer has to hedge about truncation.
            */}
            {filtered && facets
              ? t("filtered", { shown: matching, total: facets.total })
              : t("count", { count: matching })}
          </p>

          {items.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
                <p className="max-w-sm text-body text-pretty text-muted-foreground">
                  {filtered ? t("noMatches") : t("empty")}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={filtered ? "/inbox" : "/locations"}>
                    {filtered ? t("clearFilters") : t("emptyAction")}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <SelectionProvider>
              <ReviewList
                reviews={items}
                options={{
                  canUseAi,
                  // Approving and posting publish under the business's name, so
                  // they need admin. The server enforces the same rule; this only
                  // decides whether to render a control that would be refused.
                  canApprove: roleAtLeast(actor.role, "admin"),
                  highlightId: wantedReview,
                  assignees: assignees.map((member) => ({
                    userId: member.userId,
                    name: member.name,
                  })),
                  // A client may read their reviews; running the queue is the
                  // business's job. The server enforces the same rule.
                  canTriage: roleAtLeast(actor.role, "member"),
                  canSelect: canBulk && roleAtLeast(actor.role, "member"),
                }}
              />

              {/* Only offered to people who can act on a selection; the server
                  refuses the actions themselves either way. */}
              {canBulk && roleAtLeast(actor.role, "member") ? (
                <BulkBar
                  assignees={assignees.map((member) => ({
                    userId: member.userId,
                    name: member.name,
                  }))}
                  templates={templates.map((template) => ({
                    id: template.id,
                    name: template.name,
                    language: template.language,
                  }))}
                  canUseAi={canUseAi}
                />
              ) : null}

              {showLoadMore ? (
                <div className="sm:hidden">
                  {/*
                    `scroll={false}` is the whole interaction: without it the
                    navigation jumps to the top of the page and the reader loses
                    the place they were about to continue from.
                  */}
                  <Link
                    href={inboxHref(filters, { page: currentPage, more: position.more + 1 })}
                    scroll={false}
                    className="flex h-10 w-full items-center justify-center rounded-md border border-line bg-card text-copy font-medium text-foreground hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {t("loadMore")}
                  </Link>
                </div>
              ) : null}

              {/* Numbered paging is the desktop reading, and the fallback for a
                  phone that has loaded as much as one page will hold. */}
              <div className={showLoadMore ? "hidden sm:block" : undefined}>
                <Pager
                  page={currentPage}
                  pageCount={Math.max(1, Math.ceil(matching / PAGE_SIZE))}
                  // Every filter is carried through by the shared serializer, so
                  // paging never silently widens what you were looking at — and a
                  // filter added later cannot be forgotten here.
                  hrefFor={(next) => inboxHref(filters, { page: next })}
                  label={t("pagination")}
                  previousLabel={t("previous")}
                  nextLabel={t("next")}
                  status={t("range", {
                    from: (currentPage - 1) * PAGE_SIZE + 1,
                    to: (currentPage - 1) * PAGE_SIZE + items.length,
                    total: matching,
                  })}
                />
              </div>
            </SelectionProvider>
          )}
        </>
      )}
    </>
  );
}
