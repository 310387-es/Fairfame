import { AlarmClock, CheckCheck, Inbox, PenLine, ThumbsDown, UserRound } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Eyebrow } from "@/components/ds/eyebrow";
import { EMPTY_INBOX_FILTERS, inboxHref, type InboxFilterState } from "@/reviews/filters";
import { cn } from "@/lib/utils";

/**
 * The queues, as a rail rather than a row of chips (W4.1).
 *
 * The plan asks for saved views "as a real left sidebar", and the reason is
 * about what a queue *is*: All, Needs a reply, Negative, Assigned to me and
 * Overdue are not filters somebody assembles, they are the five questions this
 * screen exists to answer. As chips in a filter bar they read as options among
 * fifty; as a standing list they read as places, and the one you are in is
 * obvious without counting highlighted chips.
 *
 * It also buys back vertical space. The filter bar was six rows deep above the
 * list; the things people actually press every day now sit beside it, and the
 * long tail of source, theme and date filters stays where it was for the times
 * somebody is genuinely searching rather than working.
 *
 * **Counts come from the facets**, which are computed over the location rather
 * than the current filter — so "Needs a reply 33" still says 33 while you are
 * looking at the negative ones. A count that changed to match what you were
 * already looking at would be useless for deciding where to go next.
 */

export type ViewCounts = {
  total: number;
  unanswered: number;
  /** Written and not sent — a subset of `unanswered` (A22-A4). */
  drafted: number;
  negative: number;
  mine: number;
  overdue: number;
};

export type SavedViewLink = { id: string; name: string; href: string; shared: boolean };

export async function ViewsRail({
  filters,
  counts,
  saved,
  canTrackSla,
}: {
  filters: InboxFilterState;
  counts: ViewCounts;
  saved: SavedViewLink[];
  /** False when the plan has no `sla_tracking`, so Overdue is not offered. */
  canTrackSla: boolean;
}) {
  const t = await getTranslations("inbox");

  /**
   * Each queue as a *complete* filter state, not a patch on the current one.
   *
   * Pressing "Negative" while inside "Assigned to me" should show the negative
   * queue, not the negative-and-assigned intersection — a standing list whose
   * entries silently compose is a list where nobody can predict what a click
   * does. The sort is carried across, because reordering is not filtering.
   */
  const queue = (patch: Partial<InboxFilterState>) => ({
    ...EMPTY_INBOX_FILTERS,
    sort: filters.sort,
    ...patch,
  });

  const entries = [
    { key: "all", icon: Inbox, state: queue({}), count: counts.total },
    {
      key: "unanswered",
      icon: CheckCheck,
      state: queue({ reply: "unanswered" as const }),
      count: counts.unanswered,
    },
    /**
     * Drafted, and only when there are any (A22-A4).
     *
     * A draft used to take the review out of "Needs a reply" altogether, which
     * is how work written and never sent disappeared. It counts as unanswered
     * again — so this is a *subset* of the queue above it, not a sixth
     * competing question, and it earns its line only on a team that actually
     * drafts. W4.1 settled the rail at five entries; a permanent "0" would be
     * the sixth for nothing.
     */
    ...(counts.drafted > 0
      ? [
          {
            key: "drafted",
            icon: PenLine,
            state: queue({ reply: "drafted" as const }),
            count: counts.drafted,
          },
        ]
      : []),
    {
      key: "negative",
      icon: ThumbsDown,
      state: queue({ sentiment: "negative" as const }),
      count: counts.negative,
    },
    { key: "mine", icon: UserRound, state: queue({ assignee: "me" }), count: counts.mine },
    ...(canTrackSla
      ? [
          {
            key: "overdue",
            icon: AlarmClock,
            state: queue({ overdue: true }),
            count: counts.overdue,
          },
        ]
      : []),
  ];

  // Compared as query strings so "the same view reached two ways" is one thing.
  // `inboxHref` is the only serializer, so this cannot drift from what a link
  // actually points at.
  const current = inboxHref({ ...filters, reviews: [] });

  return (
    <nav aria-label={t("viewsLabel")} className="flex flex-col gap-1">
      {entries.map(({ key, icon: Icon, state, count }) => {
        const href = inboxHref(state);
        const active = href === current;

        return (
          <Link
            key={key}
            href={href}
            aria-current={active ? "page" : undefined}
            /*
              The chosen queue is *selected*, not merely bolder.

              It was `bg-surface-sunken` with a heavier weight — the same grey
              the hover uses, so the rail read as five identical text links and
              you had to compare font weights to see where you were. These are
              the five questions the screen exists to answer; the one you are in
              should be obvious without reading.

              Indigo wash and indigo ink, matching how a selected row is drawn
              in the list beside it and how the navigation rail marks the
              current page. One idea, one appearance, three places.
            */
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-2 text-copy transition-colors",
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              active
                ? "bg-surface-selected font-semibold text-indigo-700"
                : "text-ink-500 hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t(`view.${key}`)}</span>
            {/*
              Mono and tabular so a column of counts does not jitter — and a
              zero recedes. "Assigned to me 0" in the same ink as "Needs a reply
              46" gives equal weight to a queue with nothing in it, which is the
              one entry a reader can safely skip.
            */}
            <span
              className={cn(
                "shrink-0 font-mono text-meta tabular-nums",
                count === 0 ? "text-graphic-faint" : active ? "text-indigo-700" : "text-ink-400",
              )}
            >
              {count}
            </span>
          </Link>
        );
      })}

      {saved.length > 0 ? (
        <>
          <Eyebrow className="mt-4 mb-1 px-2.5">{t("savedViews")}</Eyebrow>
          {saved.map((view) => (
            <Link
              key={view.id}
              href={view.href}
              aria-current={view.href === current ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-copy transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                view.href === current
                  ? "bg-surface-sunken font-semibold text-foreground"
                  : "text-ink-400 hover:bg-surface-sunken/60",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{view.name}</span>
            </Link>
          ))}
        </>
      ) : null}
    </nav>
  );
}
