"use client";

import { Loader2, MessageSquare, Search, Tags } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Stars } from "@/components/ds/stars";
// The db-free module: importing from `search/queries` would pull `pg` — and
// therefore Node's `dns` — into the browser bundle.
import { MIN_QUERY_LENGTH, type SearchResults } from "@/search/types";
import { searchAction } from "@/server/search";
import { cn } from "@/lib/utils";

/**
 * ⌘K search.
 *
 * A dialog rather than an inline dropdown: search is a mode you enter, and the
 * results need room. Radix `Dialog` brings the focus trap, the Escape handler
 * and the inert background — the same reasoning as the mobile drawer.
 *
 * Results are a flat, index-addressed list so ↑/↓ can walk them across group
 * boundaries. Grouping is a heading, not a structure to navigate around: nobody
 * wants to press Tab to get from the last review to the first theme.
 *
 * Every query is debounced and *sequence-checked*. Without the sequence guard a
 * slow response for "bek" can land after a fast one for "bekleme" and overwrite
 * the newer results with older ones — the classic race that makes a palette
 * feel haunted.
 */

const EMPTY: SearchResults = { reviews: [], themes: [], hasMore: false };
const DEBOUNCE_MS = 180;

type Row =
  | { kind: "review"; id: string; href: string; label: string; meta: string; rating: number | null }
  | { kind: "theme"; id: string; href: string; label: string; meta: string; rating: null };

export function SearchPalette() {
  const t = useTranslations("shell");
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();

  // Monotonic, so a late response for an older query can be dropped.
  const sequence = useRef(0);

  // ⌘K / Ctrl-K from anywhere, and "/" when not already typing somewhere.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));

      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !typing)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;

    const term = query.trim();
    // Nothing to clear here — a query too short to search simply renders no
    // rows (see `rows` below), so stale state is never shown and the effect
    // does not have to reach back into state to say so.
    if (term.length < MIN_QUERY_LENGTH) return;

    const ticket = ++sequence.current;
    const timer = setTimeout(() => {
      startTransition(async () => {
        const next = await searchAction({ query: term });
        // A newer query has already been issued — this answer is stale.
        if (ticket !== sequence.current) return;
        setResults(next);
        setActive(0);
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, open]);

  const short = query.trim().length < MIN_QUERY_LENGTH;

  // Derived, not stored: while the query is too short the previous results are
  // still in state, and this is what keeps them off the screen.
  const rows: Row[] = short
    ? []
    : [
        ...results.reviews.map((review) => ({
          kind: "review" as const,
          id: review.id,
          href: `/reviews?review=${review.id}`,
          label: review.text?.replace(/\s+/g, " ").trim() || t("searchNoText"),
          meta: [review.authorName, review.source].filter(Boolean).join(" · "),
          rating: review.rating,
        })),
        ...results.themes.map((theme) => ({
          kind: "theme" as const,
          id: theme.slug,
          href: `/reviews?theme=${encodeURIComponent(theme.slug)}`,
          label: theme.slug,
          meta: t("searchThemeCount", { count: theme.count }),
          rating: null,
        })),
      ];

  function go(row: Row | undefined) {
    if (!row) return;
    setOpen(false);
    setQuery("");
    router.push(row.href);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Dialog.Trigger className="hidden max-w-[340px] min-w-0 flex-1 cursor-text items-center gap-2.5 rounded-md border border-line bg-surface-sunken px-3 py-[7px] text-copy text-faint transition-colors hover:bg-line-soft focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:flex">
        <Search className="size-[15px] shrink-0" aria-hidden />
        <span className="truncate">{t("searchPlaceholder")}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px]" aria-hidden>
          ⌘K
        </span>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/45 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Content
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => (rows.length ? (index + 1) % rows.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (rows.length ? (index - 1 + rows.length) % rows.length : 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              go(rows[active]);
            }
          }}
          className="fixed top-[12vh] left-1/2 z-50 flex w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-popover shadow-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <Dialog.Title className="sr-only">{t("searchTitle")}</Dialog.Title>

          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-ink-400" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchTitle")}
              // The listbox semantics live on the results below; this input is
              // the combobox that controls them.
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="search-results"
              aria-activedescendant={rows[active] ? `search-row-${active}` : undefined}
              className="h-12 flex-1 bg-transparent text-body outline-none placeholder:text-faint"
            />
            {pending ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-ink-400" aria-hidden />
            ) : null}
          </div>

          <div
            id="search-results"
            role="listbox"
            aria-label={t("searchTitle")}
            className="max-h-[52vh] overflow-y-auto p-1.5"
          >
            {short ? (
              <p className="px-3 py-6 text-center text-copy text-faint">{t("searchHint")}</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-copy text-faint">
                {pending ? t("searchBusy") : t("searchEmpty", { query: query.trim() })}
              </p>
            ) : (
              rows.map((row, index) => {
                const first =
                  index === 0 || (row.kind === "theme" && rows[index - 1]?.kind !== "theme");

                return (
                  <div key={`${row.kind}:${row.id}`}>
                    {first ? (
                      <p className="px-2.5 pt-2 pb-1 text-eyebrow text-faint uppercase">
                        {row.kind === "review" ? t("searchReviews") : t("searchThemes")}
                      </p>
                    ) : null}

                    <button
                      type="button"
                      id={`search-row-${index}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseMove={() => setActive(index)}
                      onClick={() => go(row)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
                        index === active ? "bg-surface-sunken" : "",
                      )}
                    >
                      {row.kind === "review" ? (
                        <MessageSquare className="size-3.5 shrink-0 text-ink-400" aria-hidden />
                      ) : (
                        <Tags className="size-3.5 shrink-0 text-ink-400" aria-hidden />
                      )}

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-copy">{row.label}</span>
                        {row.meta ? (
                          <span className="block truncate text-meta text-faint">{row.meta}</span>
                        ) : null}
                      </span>

                      {row.rating !== null ? (
                        <Stars
                          rating={row.rating}
                          srLabel={String(row.rating)}
                          className="shrink-0 text-state-rating-text"
                        />
                      ) : null}
                    </button>
                  </div>
                );
              })
            )}

            {results.hasMore ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(`/reviews?q=${encodeURIComponent(query.trim())}`);
                }}
                className="mt-1 w-full rounded-sm px-2.5 py-2 text-left text-meta font-semibold text-primary hover:bg-surface-sunken"
              >
                {t("searchMore")}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
