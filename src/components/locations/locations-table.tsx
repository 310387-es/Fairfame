"use client";

import { ChevronRight, Globe } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ProviderMark } from "@/components/connections/provider-mark";
import { Stars } from "@/components/ds/stars";
import { cn } from "@/lib/utils";
import { locationInboxHref, EMPTY_INBOX_FILTERS } from "@/reviews/filters";
import type { ReactNode } from "react";

/**
 * Branches as a table, with the detail one row down (W4.2).
 *
 * **What this replaces.** A grid of cards, each carrying a branch's identity,
 * its whole source list with per-source controls, and the public-page panel —
 * three unrelated jobs stacked in one box, about 320px tall, two per row. Nine
 * branches was a page you scrolled, and the one thing a multi-branch owner
 * actually does here — compare them — was impossible, because no two numbers
 * were ever on the same line.
 *
 * A table makes the comparison the default reading. The columns are the
 * questions asked in order: where is it, what feeds it, how much came in, is it
 * getting better or worse, what is waiting, is it public.
 *
 * **Everything a card could do, a row still does — one click down.** The detail
 * panel is inside the row rather than on its own page because the reason to
 * open it is almost always something you noticed in the row beside it, and a
 * navigation would lose the comparison you were in the middle of making.
 *
 * **Expanded state is not in the URL.** It is a reading posture, not a place:
 * nobody links somebody to "the Branches page with Kadıköy open", and putting
 * it in the query string would push a history entry every time somebody glanced
 * at a branch. `?review=` on the Reviews screen is the opposite case and is in
 * the URL for exactly that reason.
 */

export type LocationTableRow = {
  id: string;
  name: string;
  address: string | null;
  /** Provider keys, for the mark row. Health lives on Connections. */
  providers: string[];
  reviews: number;
  rating: number | null;
  ratingDelta: number | null;
  unanswered: number;
  publicPage: { slug: string | null; published: boolean };
  /** Already formatted and localised — a formatter cannot cross the boundary. */
  ratingLabel: string | null;
  deltaLabel: string | null;
  themes: { label: string; count: number }[];
  /** The per-branch controls, rendered on the server and passed through. */
  detail: ReactNode;
};

export function LocationsTable({ rows }: { rows: LocationTableRow[] }) {
  const t = useTranslations("locations");

  /**
   * A branch with nothing connected opens by itself.
   *
   * Found by the browser suite, which is the point of having one. Collapsing
   * every row is right for a chain being compared and wrong for the first five
   * minutes of the product: a new business lands here with one branch, no
   * sources, and a row reading "Sources — none" whose only useful control is
   * behind a chevron nobody has a reason to press. That is the same class of
   * first-mile bug Wave 1 spent itself on, reintroduced by a layout change.
   *
   * The first such row, not all of them: on an account where nothing is
   * connected the point is to do the first one, and eight open panels is a page
   * again rather than a table.
   */
  const [open, setOpen] = useState<string | null>(
    rows.find((row) => row.providers.length === 0)?.id ?? null,
  );

  return (
    /*
      The table scrolls inside its own container rather than the page. Seven
      columns do not fit a phone and never will; what must not happen is the
      whole layout growing a horizontal scrollbar, which is the P3-T8 mobile
      rule.

      `w-full` is load-bearing and was missing, which the browser suite caught.
      `overflow-x-auto` alone is enough inside a card, which is why the Insights
      comparison table gets away without it — but this sits directly in `main`,
      a column flex container, where a child's cross size comes from its
      *min-content* width. A 52rem table therefore stretched the container to
      52rem and the whole page scrolled sideways on a phone. An explicit width
      opts out of the stretch.

      `relative` is load-bearing too, and for a reason worth writing down: an
      absolutely positioned element is clipped by an ancestor's overflow **only
      if that ancestor is its containing block**. Every `Stars` in the rating
      column renders an `sr-only` label, which is `position: absolute` — with no
      positioned ancestor those resolved against the viewport, escaped the
      scroller at their static position ~500px into the table, and extended the
      *document's* scroll width to 568px. Nothing was visibly wrong; the page
      just scrolled sideways on a phone, dragged there by a screen-reader label
      one pixel wide.
    */
    <div className="relative w-full overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[52rem] border-collapse text-copy">
        {/*
          Explicit widths, because `table-auto` distributes by *content* and the
          content here is deceptive: "Google Business Profile" is a wide label
          rendered as an 18px mark, and a rating is five glyphs. Left to itself
          the browser gave the two narrowest columns half the table and pushed
          the branch names — the only thing anybody reads first — into a
          quarter of it.
        */}
        <colgroup>
          <col className="w-10" />
          <col className="w-[30%]" />
          <col className="w-[14%]" />
          <col className="w-[12%]" />
          <col className="w-[18%]" />
          <col className="w-[12%]" />
          <col className="w-[14%]" />
        </colgroup>

        <thead>
          <tr className="border-b border-line bg-surface-sunken/50 text-left">
            <Th className="w-8" srOnly>
              {t("col.expand")}
            </Th>
            <Th>{t("col.branch")}</Th>
            <Th>{t("col.sources")}</Th>
            <Th numeric>{t("col.reviews")}</Th>
            <Th>{t("col.rating")}</Th>
            <Th numeric>{t("col.unanswered")}</Th>
            <Th>{t("col.publicPage")}</Th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => {
            const expanded = open === row.id;

            return (
              <Fragment key={row.id}>
                <tr
                  className={cn(
                    "border-b border-line transition-colors",
                    expanded ? "bg-surface-sunken/60" : "hover:bg-surface-sunken/40",
                  )}
                >
                  <td className="py-2 pl-3">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={t(expanded ? "collapseRow" : "expandRow", { name: row.name })}
                      onClick={() => setOpen(expanded ? null : row.id)}
                      className="flex size-6 items-center justify-center rounded-md text-ink-400 hover:bg-surface-sunken focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <ChevronRight
                        className={cn("size-4 transition-transform", expanded && "rotate-90")}
                        aria-hidden
                      />
                    </button>
                  </td>

                  <td className="py-2 pr-3">
                    <p className="font-medium text-foreground">{row.name}</p>
                    {row.address ? (
                      <p className="truncate text-meta text-faint">{row.address}</p>
                    ) : null}
                  </td>

                  <td className="py-2 pr-3">
                    {row.providers.length === 0 ? (
                      <span className="text-meta text-faint">{t("noSources")}</span>
                    ) : (
                      <span className="flex items-center gap-1">
                        {row.providers.map((provider) => (
                          <ProviderMark key={provider} provider={provider} size={18} />
                        ))}
                      </span>
                    )}
                  </td>

                  <td className="py-2 pr-3 text-right tabular-nums">{row.reviews}</td>

                  <td className="py-2 pr-3">
                    {row.rating === null ? (
                      // Not "0.0". A branch with no rated reviews this month did
                      // not score nought stars, and a zero in a comparison table
                      // is read as a result.
                      <span className="text-meta text-faint">{t("noRating")}</span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <Stars rating={row.rating} srLabel={row.ratingLabel ?? ""} />
                        {row.deltaLabel ? (
                          <span
                            className={cn(
                              "text-meta tabular-nums",
                              (row.ratingDelta ?? 0) > 0
                                ? "text-state-positive-text"
                                : (row.ratingDelta ?? 0) < 0
                                  ? "text-state-negative-text"
                                  : "text-faint",
                            )}
                          >
                            {row.deltaLabel}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>

                  <td className="py-2 pr-3 text-right tabular-nums">
                    {row.unanswered === 0 ? (
                      <span className="text-faint">0</span>
                    ) : (
                      // A link, not a number: the only thing anybody wants to do
                      // with a backlog count is open it.
                      <Link
                        href={locationInboxHref(row.id, {
                          ...EMPTY_INBOX_FILTERS,
                          reply: "unanswered",
                        })}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.unanswered}
                      </Link>
                    )}
                  </td>

                  <td className="py-2 pr-3">
                    {row.publicPage.published && row.publicPage.slug ? (
                      <span className="inline-flex items-center gap-1 text-meta text-state-positive-text">
                        <Globe className="size-3.5" aria-hidden />
                        {t("published")}
                      </span>
                    ) : (
                      <span className="text-meta text-faint">{t("notPublished")}</span>
                    )}
                  </td>
                </tr>

                {expanded ? (
                  <tr className="border-b border-line bg-surface-sunken/30">
                    {/* Capped, not full-bleed: the controls inside were written
                        for a card and a `justify-between` row stretched across
                        1,300px puts a status badge a screen away from the label
                        it describes. */}
                    <td colSpan={7} className="px-3 py-4">
                      <div className="max-w-[56rem]">
                        {row.themes.length > 0 ? (
                          <div className="mb-4 flex flex-wrap items-center gap-1.5">
                            <span className="text-meta text-faint">{t("topThemes")}</span>
                            {row.themes.map((theme) => (
                              <span
                                key={theme.label}
                                className="rounded-full bg-surface px-2 py-0.5 text-meta text-ink-500"
                              >
                                {theme.label} <span className="tabular-nums">{theme.count}</span>
                              </span>
                            ))}
                          </div>
                        ) : null}

                        {row.detail}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  numeric = false,
  srOnly = false,
  className,
}: {
  children: ReactNode;
  numeric?: boolean;
  srOnly?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-0 py-2 text-meta font-medium text-ink-500 first:pl-3",
        numeric && "pr-3 text-right",
        !numeric && "pr-3",
        className,
      )}
    >
      <span className={cn(srOnly && "sr-only")}>{children}</span>
    </th>
  );
}
