import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { roleAtLeast } from "@/auth/permissions";
import { requireActor } from "@/auth/session";
import { InboxFilterBar, type InboxFilterState } from "@/components/inbox/filter-bar";
import { ReviewList, type InboxReview } from "@/components/inbox/review-list";
import { ScrollToReview } from "@/components/inbox/scroll-to-review";
import { Pager } from "@/components/ds/pager";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeProvider } from "@/connectors/capability-view";
import type { Sentiment } from "@/db/schema";
import { countInbox, inboxFacets, listInbox, locateReview, type ReplyState } from "@/inbox/queries";
import {
  listLocations,
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

const SENTIMENTS = ["positive", "neutral", "negative"] as const;
const REPLY_STATES = ["unanswered", "answered"] as const;

/** Query strings are user input; anything unrecognised is simply no filter. */
function parseFilters(params: Record<string, string | string[] | undefined>): InboxFilterState {
  const one = (value: string | string[] | undefined): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  const sentiment = one(params.sentiment);
  const reply = one(params.reply);

  return {
    source: one(params.source),
    sentiment: (SENTIMENTS as readonly string[]).includes(sentiment ?? "") ? sentiment : null,
    theme: one(params.theme),
    query: one(params.q),
    reply: (REPLY_STATES as readonly string[]).includes(reply ?? "") ? reply : null,
  };
}

/**
 * A page link that keeps every active filter.
 *
 * Paging must never quietly widen the list — clicking "next" on a filtered
 * inbox and landing on the unfiltered one is a small betrayal that costs the
 * reader their place.
 */
function hrefForPage(filters: InboxFilterState, page: number): string {
  const params = new URLSearchParams();

  if (filters.source) params.set("source", filters.source);
  if (filters.sentiment) params.set("sentiment", filters.sentiment);
  if (filters.theme) params.set("theme", filters.theme);
  if (filters.reply) params.set("reply", filters.reply);
  if (filters.query) params.set("q", filters.query);
  if (page > 1) params.set("page", String(page));

  const query = params.toString();
  return query ? `/inbox?${query}` : "/inbox";
}

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

  const filters = parseFilters(params);
  const cookieValue = await readActiveLocationCookie();

  // 1-based in the URL because that is what a person reading it expects; a
  // nonsense value falls back to the first page rather than erroring.
  const requested = Number.parseInt(typeof params.page === "string" ? params.page : "", 10);
  const explicitPage = Number.isInteger(requested) && requested > 0 ? requested : null;

  // `?review=<id>` means "take me to this one" — from a notification, a search
  // result or Home's queue. An explicit `?page=` still wins, so paging away
  // from the review does not keep dragging you back to it.
  const wantedReview = typeof params.review === "string" ? params.review : null;

  const queryFilters = {
    source: filters.source,
    sentiment: filters.sentiment as Sentiment | null,
    theme: filters.theme,
    query: filters.query,
    reply: (filters.reply ?? "any") as ReplyState,
  };

  const { locations, page, matching, activeLocation, facets, canUseAi, currentPage } =
    await withTenant({ organizationId: actor.organizationId, userId: actor.userId }, async (tx) => {
      const allLocations = await listLocations(tx, actor.organizationId);
      const active = resolveActiveLocation(allLocations, cookieValue);

      if (!active) {
        return {
          locations: allLocations,
          activeLocation: null,
          page: { rows: [], hasMore: false },
          matching: 0,
          facets: null,
          canUseAi: false,
          currentPage: 1,
        };
      }

      // Resolved before the list is read, because it decides which slice to read.
      const resolvedPage =
        explicitPage ??
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
          limit: PAGE_SIZE,
          offset: (resolvedPage - 1) * PAGE_SIZE,
        }),
        // The pager needs a real total, which the list cannot give it.
        matching: await countInbox(tx, actor.organizationId, active.id, queryFilters),
        facets: await inboxFacets(tx, actor.organizationId, active.id),
        // Server-side, from plan config — never `if plan === '...'`.
        canUseAi: await can({ organizationId: actor.organizationId, tx }, "ai_replies"),
      };
    });

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

  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      {/* The list streams in after the browser has already given up on the URL
          fragment, so an anchored link needs this to land. */}
      <ScrollToReview />

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
            <InboxFilterBar facets={facets} filters={filters} sourceLabels={sourceLabels} />
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
            <>
              <ReviewList
                reviews={items}
                options={{
                  canUseAi,
                  // Approving and posting publish under the business's name, so
                  // they need admin. The server enforces the same rule; this only
                  // decides whether to render a control that would be refused.
                  canApprove: roleAtLeast(actor.role, "admin"),
                  highlightId: wantedReview,
                }}
              />

              <Pager
                page={currentPage}
                pageCount={Math.max(1, Math.ceil(matching / PAGE_SIZE))}
                // Every other filter is carried through, so paging never
                // silently widens what you were looking at.
                hrefFor={(next) => hrefForPage(filters, next)}
                label={t("pagination")}
                previousLabel={t("previous")}
                nextLabel={t("next")}
                status={t("range", {
                  from: (currentPage - 1) * PAGE_SIZE + 1,
                  to: (currentPage - 1) * PAGE_SIZE + items.length,
                  total: matching,
                })}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
