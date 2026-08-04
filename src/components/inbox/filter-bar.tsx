import { AlarmClock, CheckCheck, ThumbsDown, UserRound, X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Chip, ChipGroup } from "@/components/inbox/chip";
import { Segmented } from "@/components/ds/segmented";
import {
  ASSIGNEE_ME,
  EMPTY_INBOX_FILTERS,
  hasActiveFilters,
  inboxHref,
  toggleFilter,
  type InboxFilterState,
  type ToggleableFilter,
} from "@/inbox/filters";
import type { FacetCounts } from "@/inbox/queries";

/**
 * Inbox filters (P1a-T9; quick filters and status in P2-T3).
 *
 * Links, not client state. Every filter is a URL, so a filtered Inbox can be
 * bookmarked, shared with a colleague, opened in a new tab, and — the reason
 * this shape was chosen — **linked to from a digest action**, which is what
 * makes "see the reviews behind this recommendation" a single href.
 *
 * The state and its serialization live in `@/inbox/filters`, shared with the
 * page, the pager and saved views. This file decides what to *show*; it has no
 * opinion about what a filtered URL looks like, which is what stopped a chip
 * click from quietly dropping the filters it did not know about.
 *
 * Counts come from the unfiltered location (see `inboxFacets`), so narrowing
 * never hides the option you need to widen back out.
 */

/** Toggling: clicking the active option clears it rather than reapplying it. */
function hrefFor(current: InboxFilterState, key: ToggleableFilter, value: string | number) {
  return inboxHref(toggleFilter(current, key, value));
}

export async function InboxFilterBar({
  facets,
  filters,
  sourceLabels,
  canTrackSla,
}: {
  facets: FacetCounts;
  filters: InboxFilterState;
  /** Provider key → display label, from the connector registry. */
  sourceLabels: Record<string, string>;
  /** False when the plan has no `sla_tracking`, so Overdue is not offered. */
  canTrackSla: boolean;
}) {
  const t = await getTranslations("inbox");
  const active = hasActiveFilters(filters);

  const sentimentLabel: Record<string, string> = {
    positive: t("sentimentPositive"),
    neutral: t("sentimentNeutral"),
    negative: t("sentimentNegative"),
  };

  const statusLabel: Record<string, string> = {
    open: t("statusOpen"),
    in_progress: t("statusInProgress"),
    done: t("statusDone"),
    ignored: t("statusIgnored"),
  };

  const negativeCount = facets.sentiments.find((entry) => entry.value === "negative")?.count;

  /**
   * The four one-click filters from the build plan.
   *
   * Each is a shortcut to a combination that already exists further down the bar
   * — the same URL, reached in one tap instead of two. They lead because they
   * are what someone opens the Inbox *to do*: answer what is waiting, deal with
   * what is angry, work their own queue, catch what is late. Everything below is
   * the full taxonomy, for when the shortcut is not what you meant.
   */
  const quickFilters = [
    {
      key: "unanswered",
      href: hrefFor(filters, "reply", "unanswered"),
      active: filters.reply === "unanswered",
      count: facets.unanswered,
      icon: CheckCheck,
      label: t("filterUnanswered"),
    },
    {
      key: "negative",
      href: hrefFor(filters, "sentiment", "negative"),
      active: filters.sentiment === "negative",
      count: negativeCount,
      icon: ThumbsDown,
      label: t("sentimentNegative"),
    },
    {
      key: "mine",
      href: hrefFor(filters, "assignee", ASSIGNEE_ME),
      active: filters.assignee === ASSIGNEE_ME,
      count: facets.mine,
      icon: UserRound,
      label: t("filterAssignedToMe"),
    },
    // Offered only where deadlines are tracked. A chip that filtered on a
    // promise the plan does not make would be a control that means nothing.
    ...(canTrackSla
      ? [
          {
            key: "overdue",
            href: hrefFor(filters, "overdue", "1"),
            active: filters.overdue,
            count: facets.overdue,
            icon: AlarmClock,
            label: t("filterOverdue"),
          },
        ]
      : []),
  ];

  return (
    // No bottom margin: the app shell lays pages out with the system's block
    // gap, and a margin here would double it against the list below.
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-card px-(--card-px) py-3">
      <ChipGroup label={t("filterQuick")}>
        {quickFilters.map(({ key, href, active: on, count, icon: Icon, label }) => (
          <Chip key={key} href={href} active={on} count={count}>
            <Icon className="size-3" aria-hidden />
            {label}
          </Chip>
        ))}
      </ChipGroup>

      {facets.statuses.length > 0 ? (
        <ChipGroup label={t("filterStatus")}>
          {facets.statuses.map((entry) => (
            <Chip
              key={entry.value}
              href={hrefFor(filters, "status", entry.value)}
              active={filters.status.includes(entry.value)}
              count={entry.count}
            >
              {statusLabel[entry.value]}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

      {/* Only offered when there is more than one source to choose between. */}
      {facets.sources.length > 1 ? (
        <ChipGroup label={t("filterSource")}>
          {facets.sources.map((source) => (
            <Chip
              key={source.value}
              href={hrefFor(filters, "source", source.value)}
              active={filters.source === source.value}
              count={source.count}
            >
              {sourceLabels[source.value] ?? source.value}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

      {facets.sentiments.length > 0 ? (
        <ChipGroup label={t("filterSentiment")}>
          {facets.sentiments.map((entry) => (
            <Chip
              key={entry.value}
              href={hrefFor(filters, "sentiment", entry.value)}
              active={filters.sentiment === entry.value}
              count={entry.count}
            >
              {sentimentLabel[entry.value]}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

      <ChipGroup label={t("filterReply")}>
        <Chip
          href={hrefFor(filters, "reply", "unanswered")}
          active={filters.reply === "unanswered"}
          count={facets.unanswered}
        >
          {t("filterUnanswered")}
        </Chip>
        <Chip
          href={hrefFor(filters, "reply", "answered")}
          active={filters.reply === "answered"}
          count={facets.total - facets.unanswered}
        >
          {t("filterAnswered")}
        </Chip>
      </ChipGroup>

      {facets.themes.length > 0 ? (
        <ChipGroup label={t("filterTheme")}>
          {facets.themes.map((theme) => (
            <Chip
              key={theme.value}
              href={hrefFor(filters, "theme", theme.value)}
              active={filters.theme === theme.value}
              count={theme.count}
            >
              {theme.value}
            </Chip>
          ))}
          {/*
            A theme linked from a digest may sit outside the top twelve. Showing
            it as an active chip means the filter never looks like it did
            nothing.
          */}
          {filters.theme && !facets.themes.some((theme) => theme.value === filters.theme) ? (
            <Chip href={hrefFor(filters, "theme", filters.theme)} active>
              {filters.theme}
            </Chip>
          ) : null}
        </ChipGroup>
      ) : null}

      {/* A search arriving from the palette has to be visible and removable.
          Without a chip the list looks arbitrarily short and the only way back
          is the browser's back button. */}
      {filters.query ? (
        <ChipGroup label={t("filterSearch")}>
          <Chip href={hrefFor(filters, "query", filters.query)} active>
            {filters.query}
          </Chip>
        </ChipGroup>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {/* Sorting is a link, not a toggle: the server decides the order, so it
            belongs in the URL like every filter above. */}
        <Segmented
          label={t("sort")}
          size="sm"
          items={[
            {
              href: inboxHref({ ...filters, sort: "recent" }),
              label: t("sortRecent"),
              active: filters.sort === "recent",
            },
            {
              href: inboxHref({ ...filters, sort: "priority" }),
              label: t("sortPriority"),
              active: filters.sort === "priority",
            },
          ]}
        />

        {active ? (
          // Clearing drops the filters and keeps the order — reordering is not
          // filtering, and losing it here would be a second, unasked-for change.
          <Link
            href={inboxHref({ ...EMPTY_INBOX_FILTERS, sort: filters.sort })}
            className="inline-flex items-center gap-1 text-copy text-muted-foreground underline-offset-4 hover:underline"
          >
            <X className="size-3" aria-hidden />
            {t("clearFilters")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
