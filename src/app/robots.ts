import type { MetadataRoute } from "next";
import { publicBaseUrl } from "@/lib/urls";

/**
 * `robots.txt` (P3-T3).
 *
 * The product had none, which meant every public route was crawlable by
 * default — including the ones that must never be. Three of the four public
 * surfaces here are private-by-intent and only one is meant to be indexed, so
 * the file is mostly a list of refusals.
 *
 * What is disallowed, and why each one:
 *
 *   - `/c/`, `/r/`, `/u/` — a collection page is a link handed to one customer
 *     or printed on one counter, a request carries a tracking token, and an
 *     unsubscribe link is a *one-click action*. A crawler following that last
 *     one would opt people out of their own accord. All three already say
 *     `noindex` in their metadata, but `noindex` is obeyed *after* the fetch,
 *     and a fetch is the whole problem for `/u/`.
 *   - `/embed/` — the widget document. It is `noindex` because the canonical,
 *     indexable home for those reviews is the page below, and a chrome-less
 *     fragment competing with it would split the signal.
 *   - `/api/` — machine surfaces. Nothing there renders.
 *   - The application itself. Every route under it redirects to sign-in, so a
 *     crawler gets nothing; saying so saves the round trips.
 *
 * `/reviews/` is not listed as an `allow` because it does not need to be —
 * anything not disallowed is allowed, and an explicit entry would read as if it
 * were doing something.
 */
export default function robots(): MetadataRoute.Robots {
  const base = publicBaseUrl();

  return {
    rules: {
      userAgent: "*",
      disallow: [
        "/api/",
        "/embed/",
        "/c/",
        "/r/",
        "/u/",
        "/home",
        "/inbox",
        "/digest",
        "/widgets",
        "/locations",
        "/requests",
        "/team",
        "/settings",
        "/sign-in",
        "/sign-up",
        "/create-organization",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
