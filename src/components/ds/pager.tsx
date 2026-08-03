import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Previous / next over a counted list.
 *
 * Links, not buttons — the page belongs in the URL for the same reasons every
 * other filter does: it survives a refresh, it can be shared, and the back
 * button behaves. That also means the whole thing stays server-rendered.
 *
 * Numbered page links are deliberately absent. With a filtered inbox the page
 * a row sits on changes as reviews arrive, so "page 4" is not a stable address
 * for anything — it is only ever "four pages further on", which is exactly what
 * prev/next says without pretending otherwise.
 *
 * The boundary buttons are rendered as disabled `<span>`s rather than omitted,
 * so the control keeps its shape and the next/previous target does not jump
 * sideways as you page.
 */
export function Pager({
  page,
  pageCount,
  hrefFor,
  label,
  previousLabel,
  nextLabel,
  status,
}: {
  /** 1-based. */
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  /** Names the control for assistive technology. */
  label: string;
  previousLabel: string;
  nextLabel: string;
  /** "21–40 of 137", already formatted and localised. */
  status: string;
}) {
  if (pageCount <= 1) return null;

  const base =
    "inline-flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-copy font-medium transition-colors";
  const enabled = "bg-card text-foreground hover:bg-surface-sunken";
  const disabled = "bg-surface-sunken text-graphic-faint";

  const first = page <= 1;
  const last = page >= pageCount;

  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3 pt-1">
      <p aria-live="polite" className="text-meta text-faint">
        {status}
      </p>

      <div className="flex items-center gap-2">
        {first ? (
          <span aria-disabled className={cn(base, disabled)}>
            <ChevronLeft className="size-3.5" aria-hidden />
            {previousLabel}
          </span>
        ) : (
          <Link
            href={hrefFor(page - 1)}
            rel="prev"
            className={cn(
              base,
              enabled,
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            )}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            {previousLabel}
          </Link>
        )}

        {last ? (
          <span aria-disabled className={cn(base, disabled)}>
            {nextLabel}
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        ) : (
          <Link
            href={hrefFor(page + 1)}
            rel="next"
            className={cn(
              base,
              enabled,
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            )}
          >
            {nextLabel}
            <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </nav>
  );
}
