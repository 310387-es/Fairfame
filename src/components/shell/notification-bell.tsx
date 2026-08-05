"use client";

import { AlertTriangle, Bell, Check, Clock, Loader2, UserPlus } from "lucide-react";
import { Popover } from "radix-ui";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, useTransition } from "react";
import { Stars } from "@/components/ds/stars";
// The constant from the db-free module; the type is erased, so importing it
// from `feed` costs the bundle nothing.
import type { FeedItem } from "@/notifications/feed";
import { FEED_PAGE_SIZE } from "@/notifications/types";
import {
  listNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationsReadAction,
} from "@/server/notifications";
import { cn } from "@/lib/utils";

/**
 * The notification bell and its popover.
 *
 * A panel, and the only one — there is no notifications page. A notification is
 * a glance ("what happened while I was away"), and making it a destination meant
 * leaving whatever you were doing, reading four lines and navigating back. The
 * whole feed lives here instead, loaded a page at a time as you scroll.
 *
 * The list is fetched when the popover opens, not rendered into the shell. The
 * layout already pays for the unread count on every navigation; paying for the
 * rows behind it on every screen, opened or not, is work almost nobody wants.
 *
 * Rows do not mark themselves read on hover or on open. Read state is the
 * user's record of what they have dealt with, and a feed that silently empties
 * itself because you glanced at it is a feed you stop trusting.
 */
/**
 * Does this entry describe a pile rather than one review?
 *
 * A type predicate, not an inline comparison, because there are now two rollup
 * kinds and every place that narrows the payload has to agree about all of
 * them. Missing one is how a card renders `undefined` where a rating should be.
 */
function isRollupItem(
  item: FeedItem,
): item is Extract<FeedItem, { type: "sla_rollup" | "assignment_rollup" }> {
  return item.type === "sla_rollup" || item.type === "assignment_rollup";
}

export function NotificationBell({ unread, urgent }: { unread: number; urgent: boolean }) {
  const t = useTranslations("notifications");
  const tNav = useTranslations("nav");
  const format = useFormatter();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [pending, startTransition] = useTransition();

  // Guards the sentinel against firing again while a page is already in flight —
  // an IntersectionObserver keeps reporting while the element stays on screen.
  const loading = useRef(false);

  // How many rows we have actually kept, as the offset for the next request.
  // Reading `items.length` here would read whatever the closure captured, which
  // after a fast second scroll is the *previous* page's length — and asking for
  // the same offset twice is another way to get duplicates.
  const loaded = useRef(0);

  const loadFirst = useCallback(() => {
    setExhausted(false);
    loading.current = true;
    startTransition(async () => {
      const first = await listNotificationsAction();
      setItems(first);
      loaded.current = first.length;
      setExhausted(first.length < FEED_PAGE_SIZE);
      loading.current = false;
    });
  }, []);

  const loadMore = useCallback(() => {
    if (loading.current || exhausted || items === null) return;
    loading.current = true;
    startTransition(async () => {
      const next = await listNotificationsAction({ offset: loaded.current });
      setItems((current) => {
        // Belt and braces against duplicate React keys. The stable sort in
        // `feed.ts` is what actually keeps pages from overlapping, but a list
        // that can only be correct while one `ORDER BY` stays exactly right is
        // a list that will break again — and it breaks as a crash, not a
        // wrong number.
        const seen = new Set((current ?? []).map((item) => item.id));
        const fresh = next.filter((item) => !seen.has(item.id));
        const merged = [...(current ?? []), ...fresh];
        loaded.current = merged.length;
        return merged;
      });
      // A short page means the end. Asking again would return nothing forever.
      setExhausted(next.length < FEED_PAGE_SIZE);
      loading.current = false;
    });
  }, [exhausted, items]);

  // Endless scroll driven by the scroller itself rather than by an
  // IntersectionObserver on a sentinel. The observer never attached reliably:
  // the sentinel only renders once the first page has landed, so the effect had
  // to re-run on a ref that may or may not be populated yet, and when it missed
  // there was no second chance and no error. A scroll handler on an element we
  // already own has none of that lifecycle — `loadMore` guards itself against
  // re-entry, so firing often is harmless.
  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      // A screen's worth of runway, so the next page is usually there before
      // the reader reaches the bottom.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadMore();
    },
    [loadMore],
  );

  function openReview(item: FeedItem) {
    setOpen(false);
    if (item.readAt === null) {
      startTransition(async () => {
        await markNotificationsReadAction({ ids: [item.id] });
      });
    }
    // `#review-<id>`, not `?review=<id>`. The Inbox never parsed that param —
    // it silently dropped you on an unfiltered list — whereas the anchor is a
    // real target: `review-list.tsx` puts that id on every card and reserves
    // scroll margin for the sticky header. There is no single-review route by
    // design (see `needs-attention.tsx`), so this is the honest destination.
    // `?review=` alone. It picks the page on the server, marks the row, and
    // drives the scroll — a fragment would add nothing and does not survive a
    // client-side push anyway.
    // A rollup names no review — the destination is the pile it is about, and
    // which pile depends on why it was rolled up.
    if (item.type === "sla_rollup") router.push("/inbox?overdue=1");
    else if (item.type === "assignment_rollup") router.push("/inbox?assignee=me");
    else if (item.reviewId) router.push(`/inbox?review=${item.reviewId}`);
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Re-fetch each time rather than caching: between two openings a sync
        // may have landed, and a stale list under a fresh count is worse than
        // a moment's spinner.
        if (next) loadFirst();
      }}
    >
      <Popover.Trigger
        aria-label={
          unread > 0
            ? `${tNav("notifications")} — ${tNav("unreadBadge", { count: unread })}`
            : tNav("notifications")
        }
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-md transition-colors",
          "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          "text-ink-500 hover:bg-surface-sunken hover:text-foreground data-[state=open]:bg-surface-sunken data-[state=open]:text-foreground",
        )}
      >
        <Bell className="size-4" aria-hidden />

        {unread > 0 ? (
          <span
            aria-hidden
            className={cn(
              // Pinned to the icon's top-right and pulled slightly outside it,
              // so a three-digit count grows away from the glyph, not over it.
              "absolute -top-0.5 -right-1 min-w-[17px] rounded-full px-1 py-px text-center font-mono text-[10px] leading-[1.3] font-semibold tabular-nums",
              urgent ? "bg-destructive text-white" : "bg-ink-500 text-white",
            )}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-line bg-popover shadow-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <h2 className="text-title">{t("popoverTitle")}</h2>

            {unread > 0 ? (
              <button
                type="button"
                onClick={() =>
                  startTransition(async () => {
                    await markAllNotificationsReadAction();
                    loadFirst();
                  })
                }
                className="ml-auto inline-flex items-center gap-1 rounded-sm text-meta font-semibold text-primary transition-colors hover:text-indigo-700 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Check className="size-3" aria-hidden />
                {t("markAllRead")}
              </button>
            ) : null}
          </header>

          {/* A bounded, scrolling list — the whole point of a panel over a page.
              `max-h` in viewport units so it still fits on a short laptop. */}
          <div onScroll={onScroll} className="max-h-[min(28rem,60vh)] overflow-y-auto">
            {items === null ? (
              <p className="flex items-center justify-center gap-2 px-3.5 py-10 text-copy text-faint">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t("loading")}
              </p>
            ) : items.length === 0 ? (
              <p className="px-3.5 py-10 text-center text-copy text-faint">{t("empty")}</p>
            ) : (
              <ul>
                {items.map((item) => {
                  const isUrgent = item.urgency === "urgent";
                  const isUnread = item.readAt === null;

                  return (
                    <li key={item.id} className="border-b border-line-soft last:border-b-0">
                      <button
                        type="button"
                        onClick={() => openReview(item)}
                        className={cn(
                          "flex w-full gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-surface-sunken",
                          // Unread is carried by a dot and a weight, not by a
                          // background wash — a list where most rows are tinted
                          // reads as broken rather than as unread.
                          isUnread ? "" : "opacity-70",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "mt-1.5 size-1.5 shrink-0 rounded-full",
                            isUnread
                              ? isUrgent
                                ? "bg-destructive"
                                : "bg-primary"
                              : "bg-transparent",
                          )}
                        />

                        {/* The review leads, not the location.
                            Every row said the branch name in bold first, so on a
                            single-location account the whole list looked like
                            one message repeated. What distinguishes these is the
                            rating and what the customer actually wrote. */}
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            {/* A bare red triangle was a symbol nobody had been
                                taught — it needs to say what it means. `title`
                                answers it on hover, the `sr-only` text answers
                                it for a screen reader, and the chip shape marks
                                it as a label rather than decoration. */}
                            {isUrgent ? (
                              <span
                                title={t("urgentHint")}
                                className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-state-negative-bg px-1 py-px text-[10px] font-semibold text-state-negative-text"
                              >
                                <AlertTriangle className="size-2.5" aria-hidden />
                                {t("urgent")}
                              </span>
                            ) : null}

                            {/* An arrival and a lapsed deadline can be about the
                                same review, so the two entries have to be
                                distinguishable at a glance — otherwise the
                                second reads as a duplicate of the first. */}
                            {item.type === "sla_rollup" ? (
                              <span
                                title={t("slaRollupHint")}
                                className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-state-rating-bg px-1 py-px text-[10px] font-semibold text-state-rating-text"
                              >
                                <Clock className="size-2.5" aria-hidden />
                                {t("slaBreach")}
                              </span>
                            ) : null}

                            {/* Why this arrived. Without it an assignment is
                                indistinguishable from the review's own arrival
                                alert, which is the same review and the same
                                words a few minutes earlier. */}
                            {item.type === "review_assigned" ? (
                              <span
                                title={t("assignedHint")}
                                className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-state-accent-bg px-1 py-px text-[10px] font-semibold text-state-accent-text"
                              >
                                <UserPlus className="size-2.5" aria-hidden />
                                {t("assigned")}
                              </span>
                            ) : null}

                            {item.type === "sla_breach" ? (
                              <span
                                title={t("slaBreachHint")}
                                className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-state-rating-bg px-1 py-px text-[10px] font-semibold text-state-rating-text"
                              >
                                <Clock className="size-2.5" aria-hidden />
                                {t("slaBreach")}
                              </span>
                            ) : null}

                            {isRollupItem(item) ? null : item.payload.rating !== null ? (
                              <Stars
                                rating={item.payload.rating}
                                srLabel={t("ratingLabel", { rating: item.payload.rating })}
                                className="text-state-rating-text"
                              />
                            ) : null}
                            <span
                              className={cn(
                                "truncate text-copy",
                                isUnread ? "font-semibold" : "font-medium",
                              )}
                            >
                              {item.type === "sla_rollup"
                                ? t("slaRollupTitle", { count: item.payload.count })
                                : item.type === "assignment_rollup"
                                  ? t("assignmentRollupTitle", { count: item.payload.count })
                                  : (item.payload.authorName ?? t("anonymous"))}
                            </span>
                            <span className="ml-auto shrink-0 text-meta text-faint">
                              {format.relativeTime(item.createdAt, new Date())}
                            </span>
                          </span>

                          <span className="mt-1 line-clamp-2 block text-copy text-ink-600">
                            {item.type === "sla_rollup"
                              ? t("slaRollupBody")
                              : item.type === "assignment_rollup"
                                ? t("assignmentRollupBody")
                                : (item.payload.excerpt ?? t("noText"))}
                          </span>

                          <span className="mt-1 block truncate text-meta text-faint">
                            {isRollupItem(item)
                              ? item.payload.locationName
                              : `${item.payload.locationName} · ${item.payload.source}`}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* The foot of the list: a spinner while another page is coming,
                and a full stop when there is nothing left. There is no
                notifications page to send anyone to any more. */}
            {items !== null && items.length > 0 ? (
              <div className="px-3.5 py-3 text-center text-meta text-faint">
                {exhausted ? (
                  t("endOfList")
                ) : (
                  <Loader2 className="mx-auto size-3.5 animate-spin" aria-hidden />
                )}
              </div>
            ) : null}
          </div>

          {pending ? <span className="sr-only">{t("loading")}</span> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
