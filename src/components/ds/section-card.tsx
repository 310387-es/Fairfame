import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { IconTile } from "@/components/ds/icon-tile";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The standard block: an optional icon tile, a 14px title, optional meta, and
 * one link or control pushed to the right.
 *
 * Nearly every card in the product has this header, and before this it was
 * re-typed at each call site with slightly different gaps and title sizes. If a
 * new surface needs a card, it should reach for this and only drop to a bare
 * `<Card>` when the header genuinely does not apply.
 *
 * `flush` removes the body's horizontal padding for children that must reach
 * the card edge — a chart, a divided grid of cells, a list with full-bleed row
 * separators. The header keeps its padding either way.
 */
export function SectionCard({
  id,
  title,
  icon,
  tone = "muted",
  meta,
  link,
  action,
  hideTitle = false,
  children,
  flush = false,
  className,
  bodyClassName,
}: {
  /** An anchor, for a link that has to land on this card (W1.8). */
  id?: string;
  title: ReactNode;
  icon?: LucideIcon;
  tone?: "muted" | "accent" | "rating" | "negative" | "solid";
  /** A qualifier beside the title — "Rating and volume · 30 days". */
  meta?: ReactNode;
  /** The common right-hand affordance: "See all →" out to the full view. */
  link?: { href: string; label: string };
  /** Anything else right-aligned — a toggle, a count, a button. */
  action?: ReactNode;
  /**
   * Keep the heading for assistive technology and take it off the screen.
   *
   * For a pane whose name the page has already said — the conversations list
   * sits forty pixels under an `<h1>` reading "Conversations", and printing it
   * twice is noise. A screen reader still needs it: two panes side by side with
   * only one named is worse than either.
   *
   * The card keeps no header row at all when there is nothing else in it, so
   * the pane does not open with an empty 44px band.
   */
  hideTitle?: boolean;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  const bareHeader = hideTitle && !icon && !meta && !link && !action;

  return (
    <Card {...(id ? { id } : {})} className={cn("gap-0", className)}>
      <header
        className={cn(
          "flex items-center gap-2.5 px-(--card-px) pb-3",
          bareHeader && "sr-only pb-0",
        )}
      >
        {icon ? <IconTile icon={icon} tone={tone} /> : null}
        <h2 className={cn("text-title", hideTitle && !bareHeader && "sr-only")}>{title}</h2>
        {meta ? <span className="text-meta text-faint">{meta}</span> : null}

        {link || action ? (
          <div className="ml-auto shrink-0">
            {link ? (
              <Link
                href={link.href}
                className="rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <CardLink>{link.label}</CardLink>
              </Link>
            ) : (
              action
            )}
          </div>
        ) : null}
      </header>

      {/* `flex-1` so content can centre in a card stretched to match a taller
          neighbour in the same grid row, instead of hugging the top and leaving
          a hole underneath. */}
      <div className={cn("flex-1", flush ? "" : "px-(--card-px)", bodyClassName)}>{children}</div>
    </Card>
  );
}

/**
 * "See all →" — the link that ends a card whose content is a preview.
 *
 * A link, not a button, and it says where it goes. The system's rule is that a
 * control's label describes what pressing it does: "Draft a reply" only if it
 * drafts one, otherwise it is "Reply" and it is a link like this.
 */
export function CardLink({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-meta font-semibold text-primary transition-colors hover:text-indigo-700",
        className,
      )}
    >
      {children}
      <span aria-hidden>→</span>
    </span>
  );
}
