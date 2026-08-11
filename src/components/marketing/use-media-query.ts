"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A media query, read as what it is: external state React does not own.
 *
 * The obvious implementation — `useState(false)` plus an effect that reads
 * `matchMedia` and calls `setState` — is what `react-hooks/set-state-in-effect`
 * exists to reject, and the rule is right on the substance rather than merely
 * on style: that shape renders once with a value it already knows is a guess,
 * then re-renders, and every consumer runs twice on first paint.
 *
 * `useSyncExternalStore` is the API for this. The third argument is the
 * **server** snapshot and is deliberately `false` for every caller here: the
 * server cannot know a viewport width or a motion preference, and returning
 * the same "no" it will render into the HTML is what keeps hydration quiet. A
 * client that disagrees re-renders immediately, which is correct and cheap;
 * a client that *matched* the guess never re-renders at all.
 *
 * Two callers, and they use it for opposite kinds of decision — one about
 * space (`MurmurField`, which only attaches where there is a margin to draw
 * in) and one about motion (`FlowTour`'s typewriter). Both are properties of
 * the reader's machine, which is the whole category this hook is for.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The one motion preference the brand layer honours, spelled once. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
