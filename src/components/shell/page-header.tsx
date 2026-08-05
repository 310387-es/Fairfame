import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The one h1 on a page, its subtitle, a way back up, and a page-level control.
 *
 * 25px/600 at −0.025em — the display role, and the only place it is used. A
 * page with two of these has two subjects and should be two pages.
 *
 * It carries no bottom margin: the app shell lays pages out as a flex column
 * with the system's 14px block gap, so spacing is the layout's job and a margin
 * here would silently double it.
 */
export function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: string;
  subtitle?: string;
  /**
   * The way up, for a detail page. Rendered **above the title**, which is where
   * the eye looks for it — every other convention, from a breadcrumb to a
   * platform's own back chevron, puts "up" before the thing it is above.
   *
   * It deliberately does not live in `action`. That slot is for controls that
   * act on *this* page ("Mark all read"), and a link that leaves the page is a
   * different kind of thing; the two detail pages used to put it there and it
   * read as an action.
   *
   * A destination, never `router.back()`. History answers "where did I come
   * from", which is not the question — a page opened from a bookmark, a link or
   * a reload has no useful history, and `back()` would walk the reader out of
   * the product.
   */
  back?: { href: string; label: string };
  /** Right-aligned control for the page as a whole, e.g. "Mark all read". */
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back ? (
          <Link
            href={back.href}
            className="mb-1.5 -ml-1 inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-copy text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden />
            {back.label}
          </Link>
        ) : null}

        <h1 className="text-display text-balance">{title}</h1>
        {subtitle ? <p className="mt-1 text-body text-pretty text-ink-400">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
