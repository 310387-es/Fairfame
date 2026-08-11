import { themeLabel } from "@/reviews/taxonomy";
import { sourceLabel } from "@/connectors/source-label";
import { Inbox, MapPin, SearchX } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { roleAtLeast } from "@/auth/permissions";
import { assignableMembers } from "@/auth/scope";
import { requireActor } from "@/auth/session";
import { InboxFilterBar, InboxSortBar } from "@/components/reviews/filter-bar";
import { ReviewList, type InboxReview } from "@/components/reviews/review-list";
import { ReviewDrawer } from "@/components/reviews/review-drawer";
import { ReviewRows, type ReviewRow } from "@/components/reviews/review-rows";
import { ViewsRail } from "@/components/reviews/views-rail";
import { ScrollToReview } from "@/components/reviews/scroll-to-review";
import { EmptyState } from "@/components/ds/empty-state";
import { Pager } from "@/components/ds/pager";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { describeProvider } from "@/connectors/capability-view";
import { SavedViews } from "@/components/reviews/saved-views";
import { LiveRefresh } from "@/components/reviews/live-refresh";
import { BulkBar, SelectionProvider } from "@/components/reviews/selection";
import {
  hasActiveFilters,
  inboxFilterParams,
  inboxHref,
  MAX_LOAD_MORE,
  parseInboxFilters,
  parseInboxPosition,
} from "@/reviews/filters";
import {
  countInbox,
  inboxFacets,
  listInbox,
  locateReview,
  toInboxFilters,
} from "@/reviews/queries";
import { listSavedViews } from "@/reviews/views";
import { replySignatureFor } from "@/replies/service";
import { listReplyTemplates } from "@/replies/templates";
import { slaState } from "@/reviews/workflow";
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
 * digest action link straight to the reviews behind it (`/reviews?theme=servis`)
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
  const [t, tThemes, format, actor, params] = await Promise.all([
    getTranslations("inbox"),
    // The canonical theme names, so a row's chips read as the same words the
    // filter bar above offers under "Themes".
    getTranslations("themes"),
    getFormatter(),
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
    replySignature,
  } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      // Which branches this person may see at all (P2-T4). Everything below
      // inherits the narrowing: the switcher offers fewer, and a cookie
      // pointing outside the scope falls back rather than being honoured.
      const allLocations = await listLocationsForActor(tx, actor);
      /**
       * A link may name the branch it means (W2.1).
       *
       * The Inbox is per-location and reads the active one from a cookie, which
       * is right for browsing and wrong for a *link*: a digest action pinning
       * three reviews from Kadıköy, opened by somebody whose cookie says
       * Beşiktaş, showed an empty list and said nothing about why.
       *
       * Deliberately not part of `InboxFilterState`: a saved view stores the
       * query string, and a view that pinned the branch it was created in would
       * stop following the reader's active location — which is the one thing a
       * saved view is expected to do.
       *
       * `resolveActiveLocation` is still the resolver, so the scope rule is
       * unchanged: an id outside this person's `listLocationsForActor` is not
       * honoured, it falls back. A URL cannot widen what somebody may see.
       */
      const requested = typeof params.location === "string" ? params.location : null;
      const active = resolveActiveLocation(allLocations, requested ?? cookieValue);

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
          replySignature: null,
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
        // The branch's sign-off, so a hand-written reply can be signed the same
        // way a generated one is (W5-12).
        replySignature: await replySignatureFor(tx, actor.organizationId, active.id),
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
      // `sourceLabel` already falls back for a source with no descriptor —
      // `?? review.source` printed the raw enum key.
      sourceLabel: sourceLabel(review.source),
      reply: view?.reply ?? "none",
      url: review.url,
      duplicateOfId: review.duplicateOfId,
      sentiment: review.sentiment,
      topics: review.topics,
      themes: review.themes,
      status: review.status,
      assigneeUserId: review.assignee?.id ?? null,
      // Computed on the server so every card in a render agrees about "now",
      // rather than each one asking the browser a moment apart.
      // `none` renders no badge at all, which is the honest thing to show a
      // plan that does not include deadline tracking — the data is still being
      // stamped, so an upgrade reveals real history rather than starting fresh.
      sla: canTrackSla ? slaState(review, now) : ("none" as const),
      slaDueAt: canTrackSla ? review.slaDueAt : null,
      // An owner reply made on the platform itself, normalised at ingest.
      //
      // This used to sniff `raw_payload` for an `ownerReply` key — a shape only
      // the mock connector has ever produced, so it was blind to the real
      // Google `reviewReply` — and it fed this badge and nothing else, which is
      // how a review could read "answered on Google" while the chips beside it
      // counted it unanswered and overdue. See `src/inbox/answered.ts`.
      hasOwnerReply: review.ownerRepliedAt !== null,
      reply_: review.reply,
    };
  });

  const sourceLabels = Object.fromEntries(
    (facets?.sources ?? []).map((source) => [source.value, sourceLabel(source.value)]),
  );

  const filtered = hasActiveFilters(filters);

  // The phone's pager. Offered while there is more to show and the cap has not
  // been reached; past that the numbered pager takes over on every width, so the
  // reader is never stranded at the bottom of a long list with no way forward.
  const showLoadMore = page.hasMore && position.more < MAX_LOAD_MORE;

  /**
   * Which review the detail pane shows (W4.1).
   *
   * `?review=` already existed — it is what an email alert links to — so the
   * two-pane selection reuses it rather than inventing a second idea of "the
   * one you are looking at". Falling back to nothing rather than to the first
   * row: auto-selecting would mark a review as read-by-arrival on a screen
   * somebody opened to scan.
   */
  const selected = items.find((review) => review.id === wantedReview) ?? null;

  /** The queue, projected to what a row needs to be *decided* on. */
  const rows: ReviewRow[] = items.map((review) => ({
    id: review.id,
    authorName: review.authorName,
    rating: review.rating,
    ratingLabel: review.rating === null ? null : t("starsLabel", { rating: review.rating }),
    selectLabel: t("selectReview", { author: review.authorName ?? "—" }),
    snippet: review.text,
    postedAt: review.postedAt ? format.dateTime(review.postedAt, "short") : "",
    source: review.source,
    sourceLabel: review.sourceLabel,
    // The dot is a scanning cue for "deal with this first", so it reads the
    // same two signals triage does: an unanswered negative is what matters.
    priority:
      review.sentiment === "negative" && !review.hasOwnerReply
        ? "high"
        : review.sla === "overdue" || review.sentiment === "negative"
          ? "medium"
          : "low",
    overdue: review.sla === "overdue",
    // Posted, or answered on the platform — **not** merely drafted (A22-A4).
    // The row dims what is done, and dimming a review nobody has written back
    // to is the visual half of the bug the counts had.
    answered: review.hasOwnerReply || review.reply_?.status === "posted",
    // W5-7. The badge only; the row stays in the queue and no count moves.
    duplicate: review.duplicateOfId !== null,
    /*
      What the AI found, on the row.

      Two, not all of them: the analysis is this product's differentiator and it
      was invisible until somebody opened a review, but a row that lists six
      themes is a row nobody reads. Two is enough to see a pattern down a
      column, and the filter bar above carries the full vocabulary with counts.
    */
    /*
      Canonical themes first, falling back to the free tags.

      The chips showed `topics` — the free-text tail — while the filter bar
      directly above offers **Temalar** (canonical, translated) and **Etiketler**
      (the tail) as two separate rows. So a row's chips did not correspond to
      the facets used to filter it, and on a Turkish account the column read
      "bekleme süresi, fiyat" on one row and "service, cleanliness" on the next
      — the same complaint in two languages, one under the other.

      Not canonical-only: `review_insights.themes` shipped with no backfill, so
      most rows still have none and would lose their chips entirely. Preferring
      canonical is never worse than today and gets better on its own as
      `pnpm ai:analyze --recompute` works through the backlog.
    */
    themes: (review.themes.length > 0 ? review.themes : review.topics)
      .slice(0, 2)
      .map((key) => themeLabel(key, tThemes)),
    /*
      The reply, and its state — the thing this row most obviously lacked.

      A draft is *not* a reply: it is waiting for somebody to approve and post
      it, which is work, and a row that showed it as answered would hide the one
      action left. So the state travels with the text and the row draws them
      differently.

      `hasOwnerReply` with no `reply_` means the owner answered on the platform
      before or outside Fairfame. We have the fact but not the words — the text is
      buried in `raw_payload` and normalising it is a connector change — so that
      case says only that it was answered, rather than inventing a preview.
    */
    reply:
      review.reply_ !== null
        ? {
            text: review.reply_.text,
            state: review.reply_.status === "posted" ? ("posted" as const) : ("draft" as const),
          }
        : review.hasOwnerReply
          ? { text: null, state: "posted" as const }
          : null,
  }));

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
          <EmptyState
            icon={MapPin}
            title={locations.length === 0 ? t("empty") : t("noLocationSelected")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/locations">{t("emptyAction")}</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {facets && facets.total > 0 ? (
            <InboxFilterBar
              facets={facets}
              filters={filters}
              sourceLabels={sourceLabels}
              canTrackSla={canTrackSla}
              trailing={
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <p className="text-body text-muted-foreground">
                    {/*
                      Two different truths, said differently: a filtered list and
                      the whole thing. The count is exact in both cases — the
                      pager below carries "which slice you are looking at", so
                      this no longer has to hedge about truncation.
                    */}
                    {filtered && facets
                      ? t("filtered", { shown: matching, total: facets.total })
                      : t("count", { count: matching })}
                  </p>
                  <InboxSortBar filters={filters} />
                </div>
              }
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

          {items.length === 0 ? (
            /*
              Two different nothings, and the tone says which.

              `filtered` — there are sixty-five reviews and this filter excluded
              all of them; the way out is to clear it. `blank` — there is
              genuinely nothing yet, which is a first-run moment and gets the
              brand-coloured tile and a route to connecting a source.

              The distinction was already in the copy and the link; it was not in
              the styling, so both read as the same dead end.
            */
            <Card>
              <EmptyState
                tone={filtered ? "filtered" : "blank"}
                icon={filtered ? SearchX : Inbox}
                title={filtered ? t("noMatches") : t("empty")}
                action={
                  <Button asChild variant={filtered ? "outline" : "default"} size="sm">
                    <Link href={filtered ? "/reviews" : "/locations"}>
                      {filtered ? t("clearFilters") : t("emptyAction")}
                    </Link>
                  </Button>
                }
              />
            </Card>
          ) : (
            <SelectionProvider>
              {/*
                **The queue is the screen; one review is a drawer over it.**

                W4.1 put the detail in a third pane, which is the Front /
                Superhuman shape — and that shape is for *long* documents, where
                the queue has to stay visible while you read a body that
                scrolls. A review is one to three sentences; the median on a
                real account is 53 characters.

                So the pane reserved roughly 700px for something read in two
                seconds, and paid for it out of the only column carrying the
                product's content: the customer's words got 338px, clamped. And
                that is the state you *arrive* in — nothing selected, half the
                screen a bordered box saying "choose a review".

                Two columns now, and the list takes everything the rail does not.
                The words get about three times the room; the drawer
                (`ReviewDrawer`) carries the reading and the reply. What is
                given up is seeing the queue while replying, which is the right
                trade: replying is a focused task, and `j`/`k` still move
                underneath so the drawer follows the selection instead of having
                to be closed and reopened.

                The detail is still the *same* `ReviewList` with a single
                review, server-rendered and passed into the drawer as children.
                One card, one set of triage controls, one composer — a parallel
                "detail" component is how the two drift until a control exists
                in one place only.
              */}
              <div className="grid gap-(--grid-gap) lg:grid-cols-[11.5rem_minmax(0,1fr)] lg:items-start">
                {/* The five questions this screen answers, standing still
                    (W4.1). Hidden on a phone, where the filter bar above is
                    already the way in and a third column has nowhere to go. */}
                <div className="hidden lg:block">
                  <ViewsRail
                    filters={filters}
                    counts={{
                      total: facets?.total ?? matching,
                      unanswered: facets?.unanswered ?? 0,
                      drafted: facets?.drafted ?? 0,
                      negative:
                        facets?.sentiments.find((entry) => entry.value === "negative")?.count ?? 0,
                      mine: facets?.mine ?? 0,
                      overdue: facets?.overdue ?? 0,
                    }}
                    saved={views.map((view) => ({
                      id: view.id,
                      name: view.name,
                      href: view.href,
                      shared: view.shared,
                    }))}
                    canTrackSla={canTrackSla}
                  />
                </div>

                {/*
                  The queue no longer hides when a review is chosen. It did,
                  because on a phone there was room for one thing and the detail
                  took the column; the drawer overlays instead, at every width,
                  so the list simply stays.
                */}
                <Card className="overflow-hidden p-0">
                  <ReviewRows
                    reviews={rows}
                    selectedId={selected?.id ?? null}
                    unnamed={t("anonymous")}
                    overdueLabel={t("overdue")}
                    duplicateLabel={t("duplicate")}
                    resolvedLabel={t("statusDone")}
                    // Selection belongs to the list, which is the only place
                    // more than one review exists to select.
                    canSelect={canBulk && roleAtLeast(actor.role, "member")}
                    replyLabels={{ draft: t("replyDraft"), posted: t("replySent") }}
                    // Naming the source only helps when there is another one to
                    // tell it apart from.
                    showSource={(facets?.sources.length ?? 0) > 1}
                  />
                </Card>

                {/*
                  Rendered here rather than in a portal of its own, so the
                  content stays a *server* render: `ReviewDrawer` is a client
                  shell and this is its children, which keeps the composer, the
                  triage controls and their permission checks exactly where they
                  were in the pane.

                  The "choose a review" resting state is gone with the pane. It
                  existed to explain an empty half-screen; there is no empty
                  half-screen now, and a drawer that is closed needs no caption.
                */}
                {/*
                  `closeReview` is "Close", not the old "All reviews":
                  `closeLabel` becomes the `aria-label` on the X, so that string
                  had a screen reader announcing the close button as the name of
                  the destination.
                */}
                <ReviewDrawer
                  open={selected !== null}
                  closeHref={inboxHref(filters, { page: currentPage, more: position.more })}
                  title={selected?.authorName ?? t("anonymous")}
                  closeLabel={t("closeReview")}
                >
                  {selected ? (
                    <div className="p-(--card-px)">
                      <ReviewList
                        reviews={[selected]}
                        options={{
                          canUseAi,
                          // Approving and posting publish under the business's name, so
                          // they need admin. The server enforces the same rule; this only
                          // decides whether to render a control that would be refused.
                          canApprove: roleAtLeast(actor.role, "admin"),
                          /*
                          No highlight ring here, and this is a change.

                          `?review=` used to mean one thing — "a notification
                          or a digest sent you to this review" — and the ring
                          was how it was found in a long scrolling list. W4.1
                          made the same parameter carry *ordinary selection*,
                          so the emphatic 2px indigo outline now fired on
                          every single click: a heavy ring around the detail
                          pane that reads as a validation error, restating
                          something the selected row already says.

                          The pane is the highlight. There is exactly one
                          review in it, and it arrived because you chose it.
                        */
                          highlightId: null,
                          assignees: assignees.map((member) => ({
                            userId: member.userId,
                            name: member.name,
                          })),
                          // A client may read their reviews; running the queue is the
                          // business's job. The server enforces the same rule.
                          canTriage: roleAtLeast(actor.role, "member"),
                          replySignature,
                        }}
                      />
                    </div>
                  ) : null}
                </ReviewDrawer>
              </div>

              {/* Only offered to people who can act on a selection; the server
                  refuses the actions themselves either way. */}
              {canBulk && roleAtLeast(actor.role, "member") ? (
                <BulkBar
                  pageReviewIds={rows.map((row) => row.id)}
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
                {/*
                The shortcuts, said once.

                `j`/`k`/`r`/`e` have worked since W4.1 and nothing on the screen
                mentioned them, which makes a keyboard-first queue keyboard-first
                only for whoever read the commit. A line under the list rather
                than a `?` overlay: the overlay is a second thing to discover,
                and this costs one row of muted text on the screen where the
                shortcuts apply.

                `lg` and up, because a phone has no keyboard to press them with.
              */}
                <p className="hidden items-center gap-x-3 text-meta text-faint lg:flex">
                  {/*
                    The key letters are literals, not messages, and that is the
                    point: `j` is the `j` key in every language. Putting it in
                    the catalogue invites somebody to localise a keystroke — and
                    the first attempt used next-intl rich tags to bold them,
                    which broke `i18n-messages.test.ts`, a guard that renders
                    every string with no tag handlers and was right to fail.
                    Only the verbs are translatable, so only the verbs are keys.
                  */}
                  {(
                    [
                      ["j / k", t("shortcutMove")],
                      ["r", t("shortcutReply")],
                      ["e", t("shortcutDone")],
                    ] as const
                  ).map(([keys, label]) => (
                    <span key={keys} className="flex items-center gap-1.5">
                      <kbd className="rounded-sm bg-surface-sunken px-1 font-mono text-ink-500">
                        {keys}
                      </kbd>
                      {label}
                    </span>
                  ))}
                </p>

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
