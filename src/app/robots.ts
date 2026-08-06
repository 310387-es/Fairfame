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
 * **`/reviews` is the one entry that needs a `$`, and getting it wrong would
 * silently delete the SEO feature** (W3.1). Two different things now live under
 * that word: the authenticated review inbox at `/reviews`, and the public,
 * indexable location pages at `/reviews/{slug}` — the only surface in the
 * product that is *meant* to be crawled. Robots rules match by **prefix**, so a
 * plain `Disallow: /reviews` blocks both, and the way you would find out is a
 * quiet disappearance from search results months later.
 *
 * `$` anchors the rule to the end of the URL, so it matches `/reviews` and
 * nothing beneath it. It is a Google extension rather than the original 1994
 * standard, and honoured by Google, Bing and Yandex. A crawler that does not
 * understand it reads `$` literally, matches nothing, and is free to fetch
 * `/reviews` — where it is redirected to sign-in and gets nothing anyway. That
 * is the right direction to fail in: the alternative loses the pages the
 * business earned.
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
        "/dashboard",
        // Exactly `/reviews`, never `/reviews/{slug}` — see above.
        "/reviews$",
        "/weekly-plan",
        "/widgets",
        "/locations",
        "/get-reviews",
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
