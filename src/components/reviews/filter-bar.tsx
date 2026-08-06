import { AlarmClock, CheckCheck, ThumbsDown, UserRound, X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Chip, ChipGroup } from "@/components/ds/chip";
import { isCanonicalTheme } from "@/reviews/taxonomy";
import { MIN_THEME_COVERAGE } from "@/reviews/filters";
import { Segmented } from "@/components/ds/segmented";
import {
  ASSIGNEE_ME,
  EMPTY_INBOX_FILTERS,
  hasActiveFilters,
  inboxHref,
  toggleFilter,
  type InboxFilterState,
  type ToggleableFilter,
} from "@/reviews/filters";
import type { FacetCounts } from "@/reviews/queries";

/**
 * Inbox filters (P1a-T9; quick filters and status in P2-T3).
 *
 * Links, not client state. Every filter is a URL, so a filtered Inbox can be
 * bookmarked, shared with a colleague, opened in a new tab, and — the reason
 * this shape was chosen — **linked to from a digest action**, which is what
 * makes "see the reviews behind this recommendation" a single href.
 *
 * The state and its serialization live in `@/reviews/filters`, shared with the
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
  // Bound on its own line rather than destructured out of a `Promise.all`:
  // `pnpm check:i18n` reads these bindings to know which namespace a call
  // belongs to, and it cannot see through array destructuring. Two awaits on a
  // server component cost nothing next to a check that works.
  const tThemes = await getTranslations("themes");

  /**
   * A canonical key rendered in the reader's language.
   *
   * A key from a *newer* revision than this build's catalogue would render as
   * `themes.foo`, so it falls back to the key itself — ugly, and better than a
   * chip that reads like a bug.
   */
  /**
   * Enough of the location analysed for a theme count to mean something.
   *
   * 80%, which is a judgement rather than a derivation and is written here so
   * it can be argued with in one place. Below it, one review in five is missing
   * from every count — enough that the *ranking* of themes, not just their
   * magnitude, stops being trustworthy, and ranking is what a filter bar is
   * read for.
   */
  const coverage =
    facets.themeCoverage.analysed === 0
      ? 0
      : facets.themeCoverage.withThemes / facets.themeCoverage.analysed;
  const themesReliable = coverage >= MIN_THEME_COVERAGE;

  const themeLabel = (key: string) =>
    isCanonicalTheme(key) ? tThemes(key as Parameters<typeof tThemes>[0]) : key;
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
      {/*
        The pin from a digest action, and the only filter that names rows rather
        than describing a kind of row — so nothing else on this bar can show it.
        Without a chip the reader gets three reviews out of ninety with every
        group unselected and no way back but the browser's back button: the
        theme-outside-the-top-twelve problem below, in its worst form.

        It leads because it is the strongest narrowing on the bar. Everything
        under it counts the location, not the pin, so leaving it in place while
        clicking "Negative" would read as a contradiction — which is the other
        reason this chip has to be visible: it is the one that explains why the
        numbers below no longer add up.
      */}
      {filters.reviews.length > 0 ? (
        <ChipGroup label={t("filterPinned")}>
          <Chip href={inboxHref({ ...filters, reviews: [] })} active count={filters.reviews.length}>
            {t("filterFromDigest")}
            <X className="size-3" aria-hidden />
          </Chip>
        </ChipGroup>
      ) : null}

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

      {/*
        Canonical themes first, and its own row (W3.2). These are keys with one
        meaning across languages — what can be trended, compared and translated
        — while the row below is the customer's own words. Showing `wait_time`
        beside `bekleme süresi` as siblings is exactly the confusion this
        replaces, so they are two rows with two labels rather than one list.

        Absent until reviews are re-analysed under `analyze_review@3`: the
        column is nullable with no backfill, so an account analysed before the
        taxonomy simply does not have this row yet.
      */}
      {/*
        Hidden rather than shown thin, when most reviews predate the taxonomy.

        The counts are only as complete as the column behind them, and there is
        no backfill: an account part-way through re-analysis would render
        "Staff 5" beside a Tags row built from 285 reviews. Somebody reading
        that concludes almost nobody mentioned staff, which is false — almost
        nothing has been re-analysed. A filter whose numbers are wrong by 50×
        is worse than no filter, because a chip invites a click and then hides
        nine tenths of what it claims to show.

        A note in its place rather than silence: a row that simply vanished
        would read as a bug to whoever just turned the taxonomy on, and the
        fix — re-analyse — is not something they could guess.
      */}
      {themesReliable && facets.canonicalThemes.length > 0 ? (
        <ChipGroup label={t("filterCanonical")}>
          {facets.canonicalThemes.map((theme) => (
            <Chip
              key={theme.value}
              href={hrefFor(filters, "canonical", theme.value)}
              active={filters.canonical === theme.value}
              count={theme.count}
            >
              {themeLabel(theme.value)}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

      {!themesReliable && facets.themeCoverage.analysed > 0 ? (
        <ChipGroup label={t("filterCanonical")}>
          <span className="text-copy text-muted-foreground">
            {t("themesPending", {
              done: facets.themeCoverage.withThemes,
              total: facets.themeCoverage.analysed,
            })}
          </span>
        </ChipGroup>
      ) : null}

      {facets.themes.length > 0 ? (
        <ChipGroup label={t("filterTag")}>
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
