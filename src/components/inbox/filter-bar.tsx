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
};

/** Toggling: clicking the active option clears it rather than reapplying it. */
function hrefFor(current: InboxFilterState, key: keyof InboxFilterState, value: string | null) {
  const next = { ...current, [key]: current[key] === value ? null : value };
  const params = new URLSearchParams();

  for (const [name, entry] of Object.entries(next)) {
    if (entry) params.set(name, entry);
  }

  const query = params.toString();
  return query ? `/inbox?${query}` : "/inbox";
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-xs font-medium text-muted-foreground">{label}</span>
      {children}
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
    <div className="mb-4 flex flex-col gap-2 rounded-xl border bg-card p-3">
      {/* Only offered when there is more than one source to choose between. */}
      {facets.sources.length > 1 ? (
        <Group label={t("filterSource")}>
          {facets.sources.map((source) => (
            <Chip
              key={source.value}
              href={hrefFor(filters, "source", source.value)}
              active={filters.source === source.value}
            >
              {sourceLabels[source.value] ?? source.value} · {source.count}
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
            >
              {sentimentLabel[entry.value]} · {entry.count}
            </Chip>
          ))}
        </Group>
      ) : null}

      <Group label={t("filterReply")}>
        <Chip
          href={hrefFor(filters, "reply", "unanswered")}
          active={filters.reply === "unanswered"}
        >
          {t("filterUnanswered")} · {facets.unanswered}
        </Chip>
        <Chip href={hrefFor(filters, "reply", "answered")} active={filters.reply === "answered"}>
          {t("filterAnswered")} · {facets.total - facets.unanswered}
        </Chip>
      </Group>

      {facets.themes.length > 0 ? (
        <Group label={t("filterTheme")}>
          {facets.themes.map((theme) => (
            <Chip
              key={theme.value}
              href={hrefFor(filters, "theme", theme.value)}
              active={filters.theme === theme.value}
            >
              {theme.value} · {theme.count}
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

      {active ? (
        <div className="pt-1">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            <X className="size-3" aria-hidden />
            {t("clearFilters")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
