import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CreateSheet } from "@/components/ds/create-sheet";
import { IconTile } from "@/components/ds/icon-tile";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";

/**
 * A screen that lists things you can make more of (W1.7).
 *
 * **The shape it replaces.** Locations, Requests, Surveys, Showcase and
 * Broadcasts each rendered a page header, then a permanently-open create form,
 * then the list — and, when the list was empty, a *second* box explaining that
 * it was empty. Broadcasts managed three: an "empty" card, a "new broadcast"
 * card, and inside that a paragraph saying you had to save a segment first.
 * Three boxes to say "there is nothing here yet".
 *
 * One component, three states, and only ever one card:
 *
 *   - **Empty, and you may create** — an icon, one line, one button.
 *   - **Empty, and you may not** — the same card, with the *reason* where the
 *     button would be. A disabled button explains nothing; a sentence does.
 *   - **Populated** — the list, with the create control in the page header,
 *     where every other page-level action already is.
 *
 * **No illustration**, which `docs/remediation-plan.md` asks for and `docs/15`
 * §7 forbids: "no gradients, photography, illustration or texture — the
 * product's imagery is its data". An `IconTile` carries the same weight, is
 * already the system's way of saying what kind of thing a block is, and does
 * not commit the product to commissioning artwork for every future screen.
 */

export type CreateAffordance = {
  /** The button's words. Says what it makes: "New campaign", not "Create". */
  label: string;
  /** The panel's heading. */
  title: string;
  description?: string;
  /** The form. A client component, rendered here and passed through. */
  form: ReactNode;
};

export function ResourcePage({
  title,
  subtitle,
  icon,
  isEmpty,
  empty,
  create,
  tabs,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  isEmpty: boolean;
  /** What to say when there is nothing yet. One line, not a paragraph. */
  empty: { line: string; hint?: string };
  /**
   * How to make one — or `{ blocked }` when something has to happen first.
   *
   * `null` means this reader may not create at all (a member on a screen only
   * an admin may add to), and no control is offered anywhere. The distinction
   * matters: "you cannot" and "not yet" are different sentences, and showing a
   * button for either is worse than showing neither.
   */
  create: CreateAffordance | { blocked: string } | null;
  /**
   * The section's tab strip, when this screen is one tab of a pair (W4.2).
   *
   * Rendered between the header and the body — above the empty state as well
   * as above a list, because the other tab is exactly where somebody with an
   * empty screen may need to go, and hiding the way out of an empty page is
   * how a screen becomes a dead end.
   */
  tabs?: ReactNode;
  children: ReactNode;
}) {
  const affordance = create && "label" in create ? create : null;
  const blocked = create && "blocked" in create ? create.blocked : null;

  const control = affordance ? (
    <CreateSheet
      label={affordance.label}
      title={affordance.title}
      {...(affordance.description ? { description: affordance.description } : {})}
    >
      {affordance.form}
    </CreateSheet>
  ) : null;

  return (
    <>
      {/* The control lives in the header only when there is a list beside it.
          On an empty screen it belongs in the empty state, where the reader is
          already looking, rather than tucked into a corner above nothing. */}
      <PageHeader
        title={title}
        {...(subtitle ? { subtitle } : {})}
        {...(!isEmpty && control ? { action: control } : {})}
      />

      {tabs}

      {isEmpty ? (
        <Card className="items-center gap-3 px-(--card-px) py-10 text-center">
          <IconTile icon={icon} tone="muted" />

          <div className="flex max-w-[46ch] flex-col gap-1">
            <p className="text-title">{empty.line}</p>
            {empty.hint ? <p className="text-body text-pretty text-ink-400">{empty.hint}</p> : null}
          </div>

          {blocked ? (
            <p className="max-w-[46ch] text-body text-pretty text-ink-400">{blocked}</p>
          ) : (
            control
          )}
        </Card>
      ) : (
        <>
          {children}

          {/* A populated screen still has to say why it cannot be added to —
              otherwise the missing "+ Add" reads as a bug rather than a
              prerequisite. */}
          {blocked ? <p className="text-body text-ink-400">{blocked}</p> : null}
        </>
      )}
    </>
  );
}
