"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

/**
 * Creating a thing, in a panel rather than in a form nailed to the page (W1.7).
 *
 * **What this replaces.** Every list screen in the product carried a
 * permanently-open create form: eleven controls for a campaign, sitting above
 * the campaigns, whether or not anybody wanted to make one. A screen whose most
 * prominent element is a blank form reads as unfinished — and on a screen with
 * no rows yet, the form *was* the empty state, which is why an owner opening
 * Broadcasts for the first time met a wall of selects instead of a sentence
 * explaining what a broadcast is.
 *
 * The sheet is Radix `Dialog` underneath, so focus moves in and is trapped,
 * Escape closes, and the page behind goes inert — none of which a form in the
 * page flow can offer, and all of which matter more once creating is a
 * deliberate act rather than the default state of the screen.
 */

type CreateSheetApi = { close: () => void };

const CreateSheetContext = createContext<CreateSheetApi | null>(null);

/**
 * Lets a form close the panel it is in.
 *
 * Tolerant of having no provider: the same forms are used on detail pages and
 * inside other layouts, and a hook that threw there would make the sheet a
 * condition of using the form rather than a place to put it. Outside a sheet,
 * closing is a no-op — which is exactly right, because there is nothing to
 * close.
 */
export function useCreateSheet(): CreateSheetApi {
  return useContext(CreateSheetContext) ?? { close: () => {} };
}

export function CreateSheet({
  label,
  title,
  description,
  children,
  variant = "default",
}: {
  /** The button. Says what it makes: "New campaign", not "Create". */
  label: string;
  /** The panel's heading, and its accessible name. */
  title: string;
  description?: string;
  children: ReactNode;
  variant?: "default" | "outline";
}) {
  const t = useTranslations("shell");
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant={variant}>
          <Plus className="size-4" aria-hidden />
          {label}
        </Button>
      </SheetTrigger>

      {/* From the right: this is a detail panel about one new thing, and the
          left edge already belongs to the navigation rail on mobile. */}
      <SheetContent
        side="right"
        tone="surface"
        title={title}
        // "Close", not the trigger's own words: giving the close button the
        // same accessible name as the button that opened it means a screen
        // reader announces two controls called "New widget", one of which
        // undoes the other.
        closeLabel={t("close")}
        className="w-full overflow-y-auto sm:w-lg"
      >
        <div className="flex flex-col gap-4 px-(--card-px) pb-6">
          {description ? <p className="text-body text-pretty text-ink-400">{description}</p> : null}

          <CreateSheetContext.Provider value={{ close: () => setOpen(false) }}>
            {children}
          </CreateSheetContext.Provider>
        </div>
      </SheetContent>
    </Sheet>
  );
}
