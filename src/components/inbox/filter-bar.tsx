import { X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { FacetCounts } from "@/inbox/queries";
import { cn } from "@/lib/utils";

/**
 * Inbox filters (P1a-T9).
 *
 * Links, not client state. Every filter is a URL, so a filtered Inbox can be
 * bookmarked, shared with a colleague, opened in a new tab, and — the reason
 * this shape was chosen — **linked to from a digest action**, which is what
 * makes "see the reviews behind this recommendation" a single href.
 *
 * Counts come from the unfiltered location (see `inboxFacets`), so narrowing
 * never hides the option you need to widen back out.
 */

export type InboxFilterState = {
  source: string | null;
  sentiment: string | null;
  theme: string | null;
  reply: string | null;
  /** Free text arriving from the command palette's "see all". */
  query: string | null;
};

/**
 * The URL parameter each filter is written as.
 *
 * Only `query` differs from its key — it is `?q=` because that is what people
 * expect to be able to type by hand, and what the palette links to.
 */
const PARAM: Record<keyof InboxFilterState, string> = {
  source: "source",
  sentiment: "sentiment",
  theme: "theme",
  reply: "reply",
  query: "q",
};

/** Toggling: clicking the active option clears it rather than reapplying it. */
function hrefFor(current: InboxFilterState, key: keyof InboxFilterState, value: string | null) {
  const next = { ...current, [key]: current[key] === value ? null : value };
  const params = new URLSearchParams();

  for (const [name, entry] of Object.entries(next)) {
    if (entry) params.set(PARAM[name as keyof InboxFilterState], entry);
  }

  const query = params.toString();
  return query ? `/inbox?${query}` : "/inbox";
}

/**
 * One facet option.
 *
 * A pill with the count as a separate mono element rather than baked into the
 * label as "Instagram · 67". Two typefaces doing two jobs: the name is prose and
 * the number is data, and tabular digits mean a column of chips stops changing
 * width every time the counts refresh. It is also the difference between the
 * count reading as part of the name and reading as a quantity.
 */
function Chip({
  href,
  active,
  count,
  children,
}: {
  href: string;
  active: boolean;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "border-primary bg-primary font-semibold text-primary-foreground hover:border-indigo-700 hover:bg-indigo-700"
          : "border-line bg-card font-medium text-ink-400 hover:bg-surface-sunken hover:text-foreground",
      )}
    >
      {children}
      {count === undefined ? null : (
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums",
            active ? "text-white/80" : "text-graphic-faint",
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // A two-column grid, not a wrapping flex row: the label needs its own
    // column so a group that wraps onto a second line keeps its chips aligned
    // with the first, instead of tucking them under the label.
    <div className="grid grid-cols-[3.5rem_1fr] items-start gap-1.5">
      {/* Micro-caps, like every other label on a data surface. */}
      <span className="pt-1.5 text-eyebrow text-faint uppercase">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export async function InboxFilterBar({
  facets,
  filters,
  sourceLabels,
}: {
  facets: FacetCounts;
  filters: InboxFilterState;
  /** Provider key → display label, from the connector registry. */
  sourceLabels: Record<string, string>;
}) {
  const t = await getTranslations("inbox");
  const active = Object.values(filters).some(Boolean);

  const sentimentLabel: Record<string, string> = {
    positive: t("sentimentPositive"),
    neutral: t("sentimentNeutral"),
    negative: t("sentimentNegative"),
  };

  return (
    // No bottom margin: the app shell lays pages out with the system's block
    // gap, and a margin here would double it against the list below.
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-card px-(--card-px) py-3">
      {/* Only offered when there is more than one source to choose between. */}
      {facets.sources.length > 1 ? (
        <Group label={t("filterSource")}>
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
        </Group>
      ) : null}

      {facets.sentiments.length > 0 ? (
        <Group label={t("filterSentiment")}>
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
        </Group>
      ) : null}

      <Group label={t("filterReply")}>
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
      </Group>

      {facets.themes.length > 0 ? (
        <Group label={t("filterTheme")}>
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
        </Group>
      ) : null}

      {/* A search arriving from the palette has to be visible and removable.
          Without a chip the list looks arbitrarily short and the only way back
          is the browser's back button. */}
      {filters.query ? (
        <Group label={t("filterSearch")}>
          <Chip href={hrefFor(filters, "query", filters.query)} active>
            {filters.query}
          </Chip>
        </Group>
      ) : null}

      {active ? (
        <div className="pt-1">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1 text-copy text-muted-foreground underline-offset-4 hover:underline"
          >
            <X className="size-3" aria-hidden />
            {t("clearFilters")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
