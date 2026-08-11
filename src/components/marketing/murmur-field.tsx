"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/components/marketing/use-media-query";

/**
 * The murmur, behind the front door's first viewport (docs/24 §5).
 *
 * The brand's one illustration device: invented, anonymous phrases in Lora
 * italic drifting at near-invisible opacity, sharpening toward the pointer.
 * The device is the argument — word of mouth, drawn in the only material this
 * brand has, which is words. **The phrases are invented and generic on
 * purpose**: a real customer's sentence is personal data, not decoration.
 *
 * ## Three rules it is bound by, and all three are load-bearing
 *
 * **Only here.** Never inside the app — docs/15 §7 says the product's imagery
 * is its data, and a texture behind a review queue is decoration over somebody's
 * work. That is enforced by where this component is used, and by the fact that
 * Lora itself is loaded on `/` alone.
 *
 * **It must not eat the page.** `murmur.js` inserts its canvas as the first
 * child, and an absolutely-positioned element paints *above* in-flow siblings
 * whatever the DOM order — so without the `.murmur-field` rules in
 * `globals.css` the canvas would cover the headline and swallow the call to
 * action. The canvas is pinned behind and made `pointer-events: none`; the
 * pointer handlers live on this container, so the drift still answers the
 * cursor everywhere in the hero, including over the text.
 *
 * **It must stop.** `attach` returns a `detach`, which the effect calls on
 * unmount. Every link out of this page is a client navigation, and a render
 * loop left running against a canvas nobody can see is a phone getting warm in
 * somebody's hand for no reason.
 *
 * `family` is passed in rather than left to the script's default because **the
 * bundler owns the face's name, not us**. This version of `next/font` happens to
 * emit a readable one (`Lora, "Lora Fallback"`), so the script's hardcoded
 * "Lora" would work today; older releases emitted `__Lora_<hash>`, which
 * resolves to nothing and falls back to Georgia. The texture would still
 * render, in the wrong typeface, and look entirely fine — the kind of wrong
 * nobody reports. Passing the resolved name costs one prop and does not care
 * which convention is in force.
 */

type MurmurHandle = { detach: () => void };

declare global {
  interface Window {
    Murmur?: {
      attach: (
        el: HTMLElement,
        opts: {
          carve?: boolean;
          family?: string;
          phrases?: string[];
          /** Multiplier on the resting alpha; the script clamps it at 0.6. */
          opacity?: number;
          /** Multiplier on how many phrases are seeded for the area. */
          density?: number;
          /** Multiplier on the drift. */
          speed?: number;
          /** Fade whole words toward the middle instead of clearing it. */
          veil?: boolean;
        },
      ) => MurmurHandle;
    };
  }
}

export function MurmurField({
  family,
  phrases,
  className,
  children,
}: {
  /** The resolved font-family string — `lora.style.fontFamily`, not "Lora". */
  family: string;
  /**
   * The talk, in the reader's language, already translated.
   *
   * Passed in rather than read from the catalogue here because this component
   * is `"use client"` and the phrases are a *server* decision — and because
   * `Murmur.setPhrases` is deliberately unused: a locale change in this app is
   * a cookie write and a full server re-render, so the container unmounts and
   * re-attaches with the new list. Reaching for `setPhrases` would add a second
   * way for the canvas to change language, and only one of them would be tested.
   */
  phrases: string[];
  className?: string;
  children: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  /*
    Wide viewports only, and this is a legibility decision rather than a
    performance one.

    `carve` holds a clear ellipse through the container, so the words gather in
    the margins — which is the whole composition, and which a 390px hero does
    not have. Measured on a phone, the phrases land on the subhead and on the
    source list, and that list is `text-paper-faint`: small, warm grey, over a
    drifting texture. Texture behind body copy is a contrast problem you cannot
    fix by making the texture fainter, because the fix is making it invisible.

    The query is the `lg` breakpoint, the same one the hero's own layout turns
    on. Watched rather than read once: a rotated phone and a dragged window are
    the same event to this, and re-attaching costs one reseed.
  */
  const roomy = useMediaQuery("(min-width: 64rem)");

  /*
    `veil`, not `carve`, and not a wash painted over the top either.

    Three ways to keep copy off a moving texture, and the third is the only one
    without a visible seam:

      - **carve** rejects positions inside an ellipse. The middle goes empty,
        which with a centred hero reads as a hole rather than as a background.
      - **a scrim** — a paper-to-transparent radial painted over the canvas —
        fills the middle again, but it fades *pixels*. A phrase straddling its
        edge is drawn half-visible: a sentence that stops in the middle of
        itself, which reads as a rendering fault rather than as depth.
      - **veil** scales each word's alpha by how deep its own centre sits in
        that ellipse. It fades *words*, so every phrase is whole at whatever
        opacity it has, and the field stays continuous all the way through.

    The ceiling is veiled too, not just the resting alpha — otherwise moving
    the pointer over the headline would sharpen the words underneath it back
    up to full strength, which is exactly where they must not be.

    `opacity: 1.5` lifts the resting alpha from 10% to 15% (and the amber
    minority from 34% to 51%). The ceiling near the pointer is unchanged, so
    leaning in still sharpens.

    `density: 2` doubles the seeded count — about ninety phrases on a 1440-wide
    hero rather than forty-six. **It is the reason the catalogue carries 48
    phrases**: the script deals from a shuffled deck, so the crowd can only be
    twice as thick without repeating itself if there are twice as many things
    to say. Crowding it further means writing more of them.

    `speed: 1.7` stirs the field faster without moving it further — the
    multiplier scales the drift's two sines, not their amplitude, so the words
    stay where they were placed and the crowd reads as busier rather than as
    drifting away.
  */
  useEffect(() => {
    if (!loaded || !roomy || !host.current || !window.Murmur) return;
    const murmur = window.Murmur.attach(host.current, {
      carve: false,
      family,
      phrases,
      opacity: 1.5,
      density: 2,
      speed: 1.7,
      veil: true,
    });
    return () => murmur.detach();
  }, [loaded, roomy, family, phrases]);

  return (
    <div ref={host} className={`murmur-field ${className ?? ""}`}>
      {/*
        `lazyOnload`, not `afterInteractive`: this is decoration on a page whose
        job is to be read. The headline, the briefing card and the call to
        action all render without it, and none of them should wait behind a
        canvas effect for their first paint.
      */}
      <Script src="/brand/murmur.js" strategy="lazyOnload" onReady={() => setLoaded(true)} />
      {children}
    </div>
  );
}
