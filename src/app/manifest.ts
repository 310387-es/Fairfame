import type { MetadataRoute } from "next";

/**
 * The web app manifest (W5-9).
 *
 * > **PWA + push** (owners live on their phone).
 *
 * The audit's parenthetical is the whole justification. This product's user is
 * a café owner who is standing behind a counter when the one-star review
 * arrives, and everything about the design already assumes that — the rail
 * collapses, every screen is checked at 390px, and the reply composer is
 * usable with a thumb. What was missing is the two things that make a
 * *website* behave like something on a home screen: an installable manifest,
 * and a notification that arrives when the tab is closed.
 *
 * ## Why `/dashboard` and not `/`
 *
 * `start_url` is where the icon opens. `/` is the marketing front door, and
 * somebody who installed this to their home screen has already decided; landing
 * them on a sign-up page every morning would be a small insult. An unauthorized
 * visit redirects to sign-in anyway, which is the correct answer for a phone
 * whose session has expired.
 *
 * ## `display: standalone`, not `fullscreen`
 *
 * Standalone keeps the status bar — the clock, the battery, the signal. This is
 * a tool somebody opens for ninety seconds between customers, not a game, and
 * taking the clock away from a person at work is the wrong trade.
 *
 * Colours are the two literals this file is allowed: a manifest is read by the
 * operating system before any stylesheet exists, so `--rail` and `--canvas`
 * cannot be resolved. They are copied from `globals.css` and pinned by
 * `tests/lib/manifest.test.ts` so the splash screen cannot drift from the app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fairfame",
    short_name: "Fairfame",
    description: "Reviews, replies and your weekly plan.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    // The rail's ink, so the splash screen is the app rather than a white flash.
    background_color: "#0e1734",
    theme_color: "#0e1734",
    orientation: "portrait",
    // `lang` and `dir` are deliberately absent. The product is bilingual and the
    // manifest is fetched once, without a session — declaring `tr` here would
    // tell the operating system something false for half the users.
    // Served from `public/`, copied verbatim out of `brand/` — the same files
    // `layout.tsx` declares, so the tab, the home screen and the install prompt
    // cannot show three different marks.
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        // `any` rather than `maskable`: the seal is a full-bleed circle, and a
        // maskable icon is padded and then cropped to the platform's shape —
        // which on a round mask would shave the circle it is already the shape
        // of, and on a squircle would ring it in dead space.
        purpose: "any",
      },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
