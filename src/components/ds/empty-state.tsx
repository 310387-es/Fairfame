import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one empty state.
 *
 * There were three, on adjacent screens. `/conversations` used a left-aligned
 * card with an icon beside a title and a paragraph under it; `/widgets` used a
 * centred card with the icon above a title and a button; `/reviews` used a
 * centred card with one line of grey text and nothing to press. Same product,
 * same week, three answers to "there is nothing here yet" — which is what tells
 * a customer the screens were built by different people rather than designed.
 *
 * Three parts, in a fixed order, because an empty state has one job and it is
 * not decoration: say **what would be here**, say **why it is not**, and offer
 * **the one thing that would change that**. A state with a title and no next
 * step is a dead end with better typography.
 *
 * `tone`:
 *   - `blank` — nothing exists yet. The icon carries brand colour, because this
 *     is a first-run moment and it should feel like an invitation.
 *   - `resting` — the surface is *waiting for a selection* rather than empty:
 *     the review list has plenty, you just have not picked one. Muted, no
 *     action, no colour. Making this look like a first-run screen was the
 *     mistake on `/reviews`, where "Choose a review from the list" sat in a
 *     bordered box the same size as the reviews it was asking you to choose.
 *   - `filtered` — there is data, the filter excluded it. The action clears it.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  tone = "blank",
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  /** One sentence. If it needs two, the screen needs a help link instead. */
  body?: ReactNode;
  /** The single next step. Deliberately singular — a choice is not an action. */
  action?: ReactNode;
  tone?: "blank" | "resting" | "filtered";
  className?: string;
}) {
  const resting = tone === "resting";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 text-center",
        resting ? "py-16" : "py-14",
        className,
      )}
    >
      {Icon ? (
        <span
          aria-hidden
          className={cn(
            "flex size-10 items-center justify-center rounded-lg",
            tone === "blank"
              ? "bg-state-accent-bg text-state-accent-text"
              : "bg-surface-sunken text-graphic-faint",
          )}
        >
          <Icon className="size-5" strokeWidth={1.75} />
        </span>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <p
          className={cn(
            "text-title text-balance",
            resting ? "font-medium text-ink-500" : "text-foreground",
          )}
        >
          {title}
        </p>
        {body ? (
          <p className="mx-auto max-w-[38ch] text-copy text-pretty text-muted-foreground">{body}</p>
        ) : null}
      </div>

      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
