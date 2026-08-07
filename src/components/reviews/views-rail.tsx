import { AlarmClock, CheckCheck, Inbox, ThumbsDown, UserRound } from "lucide-react";
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
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-copy transition-colors",
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              active
                ? "bg-surface-sunken font-semibold text-foreground"
                : "text-ink-400 hover:bg-surface-sunken/60",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t(`view.${key}`)}</span>
            {/* Mono and tabular so a column of counts does not jitter. */}
            <span className="shrink-0 font-mono text-meta text-graphic-faint tabular-nums">
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
