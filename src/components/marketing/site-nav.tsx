"use client";

import { Menu, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/logo";
import { HashLink } from "@/components/marketing/hash-link";
import { LocaleSwitcher } from "@/components/shell/locale-switcher";
import { type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

/**
 * The front door's masthead.
 *
 * ## The small-screen nav is new, and it is a fix rather than a port
 *
 * The landing concept hides both the section links and the call to action
 * below 900px (`.nav-links{display:none}` and `.nav-in > a.btn{display:none}`),
 * which on a phone leaves a bar containing a logo and a language button — the
 * one control a visitor does not need, and none of the four they do. That is
 * fine in a desktop-reviewed prototype and not shippable: `docs/18` measures
 * this page at 390px, where it is the *only* nav there is. So the links move
 * into a disclosure and the call to action stays on the bar at every width.
 *
 * ## The language control is the app's own, deliberately
 *
 * This first shipped as a two-sided EN/TR toggle, which is the better control
 * for exactly two locales and the wrong one for a product that expects more:
 * a toggle is a claim that there are two, made in markup, and the third
 * language would be a rebuild of this component rather than a row in
 * `LOCALES`. `LocaleSwitcher` already reads that array, so a locale added to
 * `src/i18n/config.ts` appears here with no change to this file at all.
 *
 * It also means one mechanism rather than two. The switcher writes the locale
 * cookie through `setLocaleAction`; there is no routing prefix to build a
 * per-locale URL from (`src/i18n/locale.ts`), and a second copy of that
 * decision living on the marketing page is how the two drift.
 *
 * `className` is the one concession to the surface: the shell's ghost button
 * inherits its colour from an ink rail, and this masthead is paper.
 *
 * ## Every section link is a `HashLink`, and neither `<a>` nor `Link` would do
 *
 * A plain `<a href="#faq">` leaves a history entry the App Router cannot
 * restore; a bare `<Link href="#faq">` fixes that and stops scrolling when the
 * reader is already on that hash. `hash-link.tsx` holds both halves and the
 * argument for them. The rule is the marketing surface's, not this file's —
 * `page.tsx` and `pricing.tsx` use it too.
 */

/* `[href, key]`. The key is a literal so `scripts/check-i18n.mts` can see
   it; built by interpolation it is invisible to the dead-string check. */
const SECTIONS = [
  ["how", "nav.how"],
  ["features", "nav.features"],
  ["pricing", "nav.pricing"],
  ["faq", "nav.faq"],
] as const;

export function SiteNav({ locale }: { locale: Locale }) {
  const t = useTranslations("marketing");
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  /* The hairline appears only once the page has moved, so the masthead is
     part of the hero at rest and a separated bar in front of content. */
  useEffect(() => {
    const read = () => setScrolled(window.scrollY > 8);
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, []);

  /* Escape closes it. A menu that only closes by pressing the same button is a
     trap for anyone who opened it by accident. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <nav
      className={cn(
        "sticky top-0 z-50 border-b bg-paper transition-colors",
        scrolled ? "border-paper-line" : "border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-7">
        <HashLink href="#top" aria-label="Fairfame" className="tap flex items-center">
          <Logo className="h-7" />
        </HashLink>

        <div className="ms-auto hidden gap-5 text-body font-medium text-paper-body md:flex">
          {SECTIONS.map(([id, key]) => (
            <HashLink key={id} href={`#${id}`} className="tap hover:text-brand-ink">
              {t(key)}
            </HashLink>
          ))}
        </div>

        <div className={cn("flex items-center gap-2.5", "ms-auto md:ms-0")}>
          <LocaleSwitcher locale={locale} className="tap text-paper-body hover:bg-white" />

          <HashLink
            href="#cta"
            className="tap hidden rounded-[10px] border border-brand-ink bg-brand-ink px-4 py-2.5 text-body font-semibold text-white sm:inline-flex"
          >
            {t("nav.cta")}
          </HashLink>

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="nav-menu"
            aria-label={t("nav.menu")}
            className="tap rounded-lg border border-paper-line bg-white px-2.5 py-2 md:hidden"
          >
            {open ? <X aria-hidden className="size-4" /> : <Menu aria-hidden className="size-4" />}
          </button>
        </div>
      </div>

      {/* Kept mounted and hidden rather than conditionally rendered, so the
          links are in the document for a find-in-page and the disclosure has a
          stable target to point `aria-controls` at. */}
      <div
        id="nav-menu"
        hidden={!open}
        className="border-t border-paper-line bg-paper px-7 pb-4 md:hidden"
      >
        <ul className="flex flex-col">
          {SECTIONS.map(([id, key]) => (
            <li key={id}>
              <HashLink
                href={`#${id}`}
                onClick={() => setOpen(false)}
                className="tap block border-b border-paper-line py-3 text-body font-medium text-paper-body"
              >
                {t(key)}
              </HashLink>
            </li>
          ))}
          <li className="sm:hidden">
            <HashLink
              href="#cta"
              onClick={() => setOpen(false)}
              className="tap mt-4 block rounded-[10px] bg-brand-ink px-4 py-3 text-center text-body font-semibold text-white"
            >
              {t("nav.cta")}
            </HashLink>
          </li>
        </ul>
      </div>
    </nav>
  );
}
