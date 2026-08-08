import {
  AlarmClock,
  CheckCheck,
  ChevronRight,
  Search,
  ThumbsDown,
  UserRound,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Chip, ChipGroup } from "@/components/ds/chip";
import { Input } from "@/components/ui/input";
import { themeLabel } from "@/reviews/taxonomy";
import { MIN_THEME_COVERAGE } from "@/reviews/filters";
import { Segmented } from "@/components/ds/segmented";
import {
  ASSIGNEE_ME,
  EMPTY_INBOX_FILTERS,
  hasActiveFilters,
  inboxFilterParams,
  inboxHref,
  toggleFilter,
  type InboxFilterState,
  type ToggleableFilter,
} from "@/reviews/filters";
import type { FacetCounts } from "@/reviews/queries";
import { cn } from "@/lib/utils";

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
  trailing,
}: {
  facets: FacetCounts;
  filters: InboxFilterState;
  /**
   * The result count and the sort, on the same line as "More filters".
   *
   * They were a band of their own between this card and the list, so the screen
   * opened with three stacked strips of chrome before a single review. They are
   * *about* the list rather than filters of it, which is why they are passed in
   * rather than built here — this component still has no idea how many rows
   * matched, and should not.
   */
  trailing?: ReactNode;
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

  const label = (key: string) => themeLabel(key, tThemes);

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

      {/*
        Phone only, because on a wide screen the queues rail beside the list is
        already these four (W4.1) — and until now they were rendered *twice*,
        one above the other. "Needs a reply 40" appeared as a chip here and as a
        rail entry 300px below it, which is not a redundancy anybody reads as
        deliberate: it reads as two controls that might do different things.

        The rail was added to buy back the vertical space this bar was spending;
        leaving the chips in place meant it never did. Removing them lifts the
        first review roughly 60px up the page on the screen people spend their
        day in. Below `lg` the rail is hidden and these are the only way in, so
        they stay.
      */}
      <div className="lg:hidden">
        <ChipGroup label={t("filterQuick")}>
          {quickFilters.map(({ key, href, active: on, count, icon: Icon, label }) => (
            <Chip key={key} href={href} active={on} count={count}>
              <Icon className="size-3" aria-hidden />
              {label}
            </Chip>
          ))}
        </ChipGroup>
      </div>

      {/*
        The three axes that describe *a kind of review*, on one line.

        They were three stacked rows, each a 6rem label column and two or three
        chips — which left the right two-thirds of a 1100px card empty and spent
        three rows of height saying very little. Side by side they are one row,
        they wrap to two on a narrow window, and the card reads as a toolbar
        rather than as a form somebody stopped filling in.
      */}
      {/*
        **The search box the screen never had.**

        Everything behind it already existed: `?q=`, `searchPredicate` in the
        query layer, `query` in the filter state, and a chip further down that
        *displays* an active search. The only missing piece was somewhere to
        type — so a screen holding hundreds of reviews, twenty at a time, could
        show you a search filter it gave you no way to create. The one way in
        was the global palette, which is a *navigation* control ("take me to
        this review"), not a filter ("show me everything about parking").

        A plain `<form method="get">`, the same shape `/contacts` uses, rather
        than a client component: it works with no JavaScript, and a text box
        that submits on Enter needs no more machinery than that.

        It carries every other filter as a hidden input, or pressing Enter would
        silently drop the sentiment you had selected. The sort travels too — not
        a filter, but losing it here would still be a surprise.
      */}
      <form method="get" action="/reviews" role="search" className="flex min-w-0 gap-2">
        {[...inboxFilterParams({ ...filters, query: null }).entries()].map(([key, value]) => (
          <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
        ))}

        <div className="relative min-w-0 flex-1 sm:max-w-96">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-graphic-faint"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            defaultValue={filters.query ?? ""}
            aria-label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            className="pl-8"
          />
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {facets.statuses.length > 0 ? (
          <ChipGroup layout="inline" label={t("filterStatus")}>
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

        {facets.sentiments.length > 0 ? (
          <ChipGroup layout="inline" label={t("filterSentiment")}>
            {facets.sentiments.map((entry) => (
              <Chip
                key={entry.value}
                href={hrefFor(filters, "sentiment", entry.value)}
                active={filters.sentiment === entry.value}
                count={entry.count}
              >
                {/*
                  A dot in the sentiment's own colour.

                  Positive, neutral and negative are three different things and
                  rendered as three identical grey pills, so the chip a worried
                  owner reaches for looked exactly like the two they do not. The
                  colours already exist and already mean this — the split bars
                  on the dashboard and the heatmap on Analytics use the same
                  three — so this is the filter agreeing with the charts it
                  filters.

                  A dot rather than a tinted chip: the chip's own fill already
                  carries *selected*, and two colour systems on one control is
                  how a filter bar stops being readable.
                */}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    entry.value === "positive"
                      ? "bg-sentiment-positive"
                      : entry.value === "negative"
                        ? "bg-sentiment-negative"
                        : "bg-sentiment-neutral",
                  )}
                />
                {sentimentLabel[entry.value]}
              </Chip>
            ))}
          </ChipGroup>
        ) : null}

        <ChipGroup layout="inline" label={t("filterReply")}>
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
      </div>

      {/*
        **The long tail, folded away.**

        This bar was six rows of chips — status, source, sentiment, reply,
        themes, tags — about 300px of controls standing permanently on top of
        the queue they filter, on the screen people spend their whole day in.
        Three of those rows are the taxonomy: source, canonical themes and the
        customer's own words. They are worth having and they are not what
        anybody opens this screen to press; the rail beside the list is.

        So the three axes that describe *a kind of review* stay out — status,
        sentiment, reply — and the three that describe *a subject* fold into a
        disclosure. Everything is still one keystroke away and still a plain
        link, so nothing about search, sharing or the back button changes.

        `<details>` rather than client state, deliberately: this is a server
        component rendering links, the whole bar works with scripts off, and
        adding a `useState` here would be the one thing on the screen that did
        not. It also opens itself when a filter inside it is on — `open` is
        computed, so arriving from a digest link on a theme never shows an empty
        bar with a mysteriously short list underneath.
      */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <details
          open={
            Boolean(filters.source) ||
            Boolean(filters.canonical) ||
            Boolean(filters.theme) ||
            Boolean(filters.query)
          }
          className="group/more"
        >
          <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm py-0.5 text-meta font-semibold text-ink-500 transition-colors select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3 transition-transform group-open/more:rotate-90"
              aria-hidden
            />
            {t("filterMore")}
          </summary>

          <div className="flex flex-col gap-2 pt-2">
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
                    {/*
                      The provider's mark — the same drawn geometry the review
                      row and the Connections screen use. A source is the one
                      filter with a real-world identity attached, and "Google
                      Business Profile" as plain text beside "First-party page"
                      made two very different things look like two words.
                    */}
                    <ProviderMark provider={source.value} size={14} />
                    {sourceLabels[source.value] ?? source.value}
                  </Chip>
                ))}
              </ChipGroup>
            ) : null}

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
                    {label(theme.value)}
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
              Without a chip the list looks arbitrarily short and the only way
              back is the browser's back button. */}
            {filters.query ? (
              <ChipGroup label={t("filterSearch")}>
                <Chip href={hrefFor(filters, "query", filters.query)} active>
                  {filters.query}
                </Chip>
              </ChipGroup>
            ) : null}
          </div>
        </details>

        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
    </div>
  );
}

/**
 * Order and "clear", as their own strip.
 *
 * Split out of the bar above because they are not filters: sorting describes
 * how the list is arranged and clearing undoes the bar itself. Inside the card
 * they sat on a fourth row under three rows of chips, which is where the bar
 * got its height. The page renders this next to the result count, where a sort
 * control belongs — beside the thing it orders.
 */
export async function InboxSortBar({ filters }: { filters: InboxFilterState }) {
  const t = await getTranslations("inbox");
  const active = hasActiveFilters(filters);

  return (
    <div className="flex flex-wrap items-center gap-3">
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
  );
}
