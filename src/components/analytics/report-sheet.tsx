"use client";

import { CalendarClock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

/**
 * Scheduling the report, from the page header (W4.4).
 *
 * **Why it moved.** The schedule was a card in the middle of the data, between
 * the competitor benchmark and the staff panel — a *setting* filed among
 * *findings*. Everything else on that page answers a question about the
 * business; this one configures an email, and somebody scrolling for the third
 * time to find it had already told us it was in the wrong place.
 *
 * `docs/remediation-plan.md` asks for an "Export / Schedule split button", and
 * that is what this is the second half of: two adjacent controls in the header
 * that read as one, because they are the two things you do with these numbers
 * once you have looked at them — take them now, or have them sent.
 *
 * **A sheet, not a dropdown.** The schedule is a form with three controls and a
 * save; a dropdown menu is for choosing one of a list, and putting selects
 * inside one produces the nested-popover bug every design system eventually
 * files. The sheet traps focus, closes on Escape, and makes the page behind
 * inert — which a setting deserves and a menu cannot give.
 *
 * The form itself is unchanged and is passed in as a child, so the card that
 * existed and this panel cannot drift into two versions of the same controls.
 */
export function ReportSheet({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  const t = useTranslations("shell");
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <CalendarClock className="size-4" aria-hidden />
          {label}
        </Button>
      </SheetTrigger>

      <SheetContent
        side="right"
        tone="surface"
        title={title}
        // "Close", not the trigger's words — the same reasoning `CreateSheet`
        // records: two controls sharing an accessible name, one undoing the
        // other, is what a screen reader would otherwise announce.
        closeLabel={t("close")}
        className="w-full overflow-y-auto sm:w-lg"
      >
        <div className="px-(--card-px) pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
