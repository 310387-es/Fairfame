import type { ReactNode } from "react";

/**
 * The one h1 on a page, its subtitle, and a page-level control.
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
  action,
}: {
  title: string;
  subtitle?: string;
  /** Right-aligned control for the page as a whole, e.g. "Mark all read". */
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-display text-balance">{title}</h1>
        {subtitle ? <p className="mt-1 text-body text-pretty text-ink-400">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
