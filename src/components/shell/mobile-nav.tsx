"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

/**
 * The navigation rail, on a phone.
 *
 * Below `md` the rail is hidden, and until this existed nothing replaced it —
 * you could reach Home and then you were stranded, with no route to the Inbox,
 * notifications or settings. For a product whose own brief says owners act from
 * their phones, that was the largest hole in the design.
 *
 * It is the same `SidebarNav` on the same ink surface rather than a reduced
 * menu: a phone user and a desktop user should not have to learn two different
 * information architectures, and a "mobile subset" is how destinations quietly
 * become unreachable.
 *
 * `footer` is passed in rather than imported because `TrialFooter` is an async
 * server component — it reads entitlements and formats a date on the server, and
 * this has to be a client component to hold the open/closed state. Server output
 * crossing as `children` keeps that work off the browser.
 */
export function MobileNav({ footer }: { footer: ReactNode }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close on navigation. Next moves between routes on the client without
  // unmounting this, so without it the drawer would sit open over the page it
  // just took you to.
  //
  // Adjusted during render rather than in an effect: React re-runs this pass
  // before touching the DOM, so the drawer is never painted open over the new
  // route the way a post-render effect would let it flash. Watching the
  // pathname also covers back/forward, which closing on link click would miss.
  const [renderedPath, setRenderedPath] = useState(pathname);
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={t("openMenu")}
        className="-ml-1 grid size-9 shrink-0 place-items-center rounded-md text-ink-600 transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:hidden"
      >
        <Menu className="size-5" aria-hidden />
      </SheetTrigger>

      {/* The panel is named "Menu", not "Open menu" — that is the button's job.
          A dialog inherits no name from the control that opened it, and reusing
          the trigger's label makes a screen reader announce the thing you are
          already inside as the action that got you there. */}
      <SheetContent title={t("menu")} hideTitle closeLabel={t("closeMenu")}>
        <div className="flex h-(--topbar-height) items-center gap-2.5 px-[18px] text-base font-semibold tracking-[-0.01em]">
          <Logo className="text-white" markClassName="size-[26px]" />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SidebarNav />
        </div>

        {footer}
      </SheetContent>
    </Sheet>
  );
}
