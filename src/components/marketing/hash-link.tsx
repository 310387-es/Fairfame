"use client";

import Link from "next/link";

/**
 * A same-page anchor on the marketing surface. Every `#section` link goes
 * through this, and it exists because the two obvious implementations each get
 * half of it right.
 *
 * **A plain `<a href="#faq">` is a browser navigation.** It pushes a history
 * entry the App Router never saw, so that entry's `history.state` is `null`
 * rather than Next's route tree. On the way back into it the router has no tree
 * to restore, leaves whatever is currently mounted, and lets the browser change
 * the URL underneath it — the visitor reads the FAQ, signs in, presses back,
 * and watches the address bar say `/#faq` while the sign-in form stays on
 * screen. It takes three steps to show up, which is why it survived a hand test
 * of the page: nobody clicking through the front door in order does that, and
 * everybody who reads a question and then signs in does.
 *
 * **A bare `<Link href="#faq">` fixes that and drops the scroll.** Next treats
 * a push to the URL the reader is already on as nothing to do, so a visitor
 * whose address bar still says `#faq` — because that is where they last jumped
 * — can scroll away, click "Questions", and have the nav appear broken.
 *
 * So: `Link` for the history entry, and an explicit `scrollIntoView` for the
 * movement, which is the one thing that must happen on every click regardless
 * of what the URL already says. `scrollIntoView` honours `scroll-margin-top`,
 * so the section still stops below the masthead rather than behind it
 * (`globals.css`, `.marketing section[id]`).
 */
export function HashLink({
  href,
  onClick,
  children,
  ...rest
}: Omit<React.ComponentProps<typeof Link>, "href"> & { href: string }) {
  return (
    <Link
      href={href}
      onClick={(event) => {
        onClick?.(event);
        document.getElementById(href.slice(1))?.scrollIntoView();
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
