"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { inboxPulseAction } from "@/server/inbox-pulse";

/**
 * Keeps the inbox current without anybody pressing anything (P2-T7).
 *
 * Polls a count, and calls `router.refresh()` only when it moves. The refresh is
 * a *soft* one: Next re-fetches the server-rendered payload and reconciles it,
 * so client state inside the cards survives — a half-written reply in a composer
 * is still there afterwards, which is the thing that would make an auto-updating
 * inbox unusable if it were not true. Cards are keyed by review id, so an
 * arrival at the top does not remount the ones below it either.
 *
 * Three restraints, each earning its place:
 *
 *   - **Only while the tab is visible.** A background tab that keeps polling is
 *     a background tab that keeps a database busy for nobody. Visibility change
 *     triggers an immediate check, so coming back to the tab is instant rather
 *     than up to one interval stale.
 *   - **Only when the count changed.** A quiet inbox costs one small query per
 *     tick and re-renders nothing.
 *   - **Never mid-navigation.** The pulse carries the same query string the page
 *     was rendered with, so a stale in-flight poll cannot refresh a page that
 *     has since been filtered differently.
 */
export function LiveRefresh({
  params,
  matching,
  intervalMs = 30_000,
}: {
  /** The query string this page was rendered for. */
  params: Record<string, string>;
  /** The count this render was built from. */
  matching: number;
  intervalMs?: number;
}) {
  const router = useRouter();

  // Refs, not state: nothing here should cause a render of its own. The only
  // visible effect is the refresh.
  const known = useRef(matching);
  const busy = useRef(false);

  // The rendered count is the new truth after every render, including ones this
  // component did not cause — a filter change, a teammate's edit, a back button.
  useEffect(() => {
    known.current = matching;
  }, [matching]);

  // Serialized, because `params` is a fresh object on every render. Depending on
  // the object itself would tear down and rebuild the timer each time the page
  // re-rendered — including after a refresh this component triggered — so the
  // interval would keep restarting and, in a busy inbox, effectively never fire.
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    const query = JSON.parse(paramsKey) as Record<string, string>;
    let cancelled = false;

    async function check() {
      if (busy.current || cancelled || document.visibilityState !== "visible") return;
      busy.current = true;

      try {
        const pulse = await inboxPulseAction({ params: query });
        // Cancelled means the filters changed while this was in flight, so the
        // answer is about a page that is no longer on screen.
        if (cancelled) return;
        // A null count means the poll could not answer — no location, or a
        // failure it already logged. Not a reason to refresh.
        if (pulse.matching !== null && pulse.matching !== known.current) {
          known.current = pulse.matching;
          router.refresh();
        }
      } finally {
        busy.current = false;
      }
    }

    const timer = setInterval(check, intervalMs);
    document.addEventListener("visibilitychange", check);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [paramsKey, intervalMs, router]);

  return null;
}
