"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Scrolls to the review a deep link asked for.
 *
 * Keyed on `?review=<id>`, not on the URL fragment. Two separate reasons the
 * fragment could not carry this:
 *
 *   - The browser only acts on a fragment for an element that exists when it
 *     parses the URL, and the review list streams in afterwards.
 *   - Next's client-side `router.push` rewrites the URL through the History
 *     API without performing a fragment navigation at all, so arriving from the
 *     notification popover never produced a scroll *or* a `:target` match.
 *
 * The param has neither problem: it survives both paths, it is what the server
 * already used to pick the page, and depending on it here means clicking a
 * second notification re-scrolls rather than sitting still.
 *
 * A `MutationObserver` rather than a timeout, because "when has the list
 * rendered?" has no fixed answer. It gives up after a few seconds so a link to
 * a review the current filters exclude does not watch the DOM forever.
 */
export function ScrollToReview() {
  const reviewId = useSearchParams().get("review");

  useEffect(() => {
    if (!reviewId) return;

    const attempt = () => {
      const target = document.getElementById(`review-${reviewId}`);
      if (!target) return false;
      // `scroll-mt` on the row keeps it clear of the sticky header; `instant`
      // because this is a destination, not a gesture — smooth-scrolling past
      // twenty cards is a second of nothing happening.
      target.scrollIntoView({ block: "start", behavior: "instant" });
      return true;
    };

    if (attempt()) return;

    const observer = new MutationObserver(() => {
      if (attempt()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const giveUp = setTimeout(() => observer.disconnect(), 5_000);

    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
    };
  }, [reviewId]);

  return null;
}
