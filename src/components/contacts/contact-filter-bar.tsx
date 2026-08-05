import { MailX, Search, ShieldCheck, X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Chip, ChipGroup } from "@/components/ds/chip";
import { Segmented } from "@/components/ds/segmented";
import { Input } from "@/components/ui/input";
import {
  CONTACT_SORTS,
  contactFilterParams,
  contactsHref,
  EMPTY_CONTACT_FILTERS,
  hasActiveContactFilters,
  toggleContactFilter,
  type ContactFilterState,
} from "@/contacts/filters";
import type { ContactTagSummary } from "@/contacts/tags";

/**
 * Contact filters (P4-T1).
 *
 * Links, not client state — the same decision the Inbox made and for the same
 * reasons: a filtered list is a URL, so it can be bookmarked, shared with a
 * colleague and, the reason it matters here, **saved as a segment**. A segment
 * is literally this query string with a name on it.
 *
 * The search box is the one exception, and it is a plain `<form method="get">`
 * rather than a client component. It carries the other filters as hidden inputs
 * so typing a name does not silently drop the tag you had selected, and it works
 * with no JavaScript at all — which is the correct amount of machinery for a
 * text box that submits on Enter.
 */

function hrefFor(
  current: ContactFilterState,
  key: Exclude<keyof ContactFilterState, "sort">,
  value: string,
): string {
  return contactsHref(toggleContactFilter(current, key, value));
}

export async function ContactFilterBar({
  filters,
  tags,
  locations,
}: {
  filters: ContactFilterState;
  /** The organization's labels, most-used first. */
  tags: ContactTagSummary[];
  /** Only the ones this member may see — the location filter must not widen scope. */
  locations: { id: string; name: string }[];
}) {
  const t = await getTranslations("contacts");
  const active = hasActiveContactFilters(filters);

  // The search form has to resubmit everything else, or pressing Enter would
  // clear the filters around it. Sort included: it is not a filter, but losing
  // it on search would still be a surprise.
  const carried = contactFilterParams({ ...filters, query: null });

  const sortLabel: Record<(typeof CONTACT_SORTS)[number], string> = {
    recent: t("sortRecent"),
    name: t("sortName"),
    activity: t("sortActivity"),
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-card px-(--card-px) py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form method="get" action="/contacts" role="search" className="flex min-w-0 flex-1 gap-2">
          {[...carried.entries()].map(([key, value]) => (
            <input key={`${key}:${value}`} type="hidden" name={key} value={value} />
          ))}

          <div className="relative min-w-0 flex-1 sm:max-w-80">
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

        <Segmented
          label={t("sortLabel")}
          size="sm"
          items={CONTACT_SORTS.map((sort) => ({
            href: contactsHref({ ...filters, sort }),
            label: sortLabel[sort],
            active: filters.sort === sort,
          }))}
        />
      </div>

      {tags.length > 0 ? (
        <ChipGroup label={t("filterTags")}>
          {tags.map((tag) => (
            <Chip
              key={tag.slug}
              href={hrefFor(filters, "tags", tag.slug)}
              active={filters.tags.includes(tag.slug)}
              count={tag.contactCount}
            >
              {tag.label}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

      <ChipGroup label={t("filterState")}>
        <Chip
          href={hrefFor(filters, "subscription", "unsubscribed")}
          active={filters.subscription === "unsubscribed"}
        >
          <MailX className="size-3" aria-hidden />
          {t("filterUnsubscribed")}
        </Chip>
        {/*
          "Holds a permission", not "we may message them". The gate decides the
          second, at send time, and it asks the registry — see the note on
          ContactFilterState.consent. The label says so rather than implying a
          send would succeed.
        */}
        <Chip href={hrefFor(filters, "consent", "message")} active={filters.consent === "message"}>
          <ShieldCheck className="size-3" aria-hidden />
          {t("filterConsentMessage")}
        </Chip>
        <Chip href={hrefFor(filters, "consent", "email")} active={filters.consent === "email"}>
          <ShieldCheck className="size-3" aria-hidden />
          {t("filterConsentEmail")}
        </Chip>
        <Chip href={hrefFor(filters, "channel", "email")} active={filters.channel === "email"}>
          {t("filterHasEmail")}
        </Chip>
        <Chip href={hrefFor(filters, "channel", "phone")} active={filters.channel === "phone"}>
          {t("filterHasPhone")}
        </Chip>
      </ChipGroup>

      {/* One branch is not a choice; the chips only appear where there are two. */}
      {locations.length > 1 ? (
        <ChipGroup label={t("filterLocation")}>
          {locations.map((location) => (
            <Chip
              key={location.id}
              href={hrefFor(filters, "locationId", location.id)}
              active={filters.locationId === location.id}
            >
              {location.name}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}

      {active ? (
        <div>
          <Link
            href={contactsHref({ ...EMPTY_CONTACT_FILTERS, sort: filters.sort })}
            className="inline-flex items-center gap-1 rounded-sm text-meta font-semibold text-primary transition-colors hover:text-indigo-700 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden />
            {t("clearFilters")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
