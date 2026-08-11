"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

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
      attach: (el: HTMLElement, opts: { carve?: boolean; family?: string }) => MurmurHandle;
    };
  }
}

export function MurmurField({
  family,
  className,
  children,
}: {
  /** The resolved font-family string — `lora.style.fontFamily`, not "Lora". */
  family: string;
  className?: string;
  children: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [roomy, setRoomy] = useState(false);

  /*
    Wide viewports only, and this is a legibility decision rather than a
    performance one.

    `carve` holds a clear ellipse through the middle of the container, so the
    words gather in the margins — which is the whole composition, and which a
    390px hero does not have. Measured on a phone, the phrases land on the
    subhead and on the no-card note, and that note is `text-faint`: small, light
    grey, over a drifting texture. Texture behind body copy is a contrast
    problem you cannot fix by making the texture fainter, because the fix is
    making it invisible.

    `ROOMY` is the `lg` breakpoint, the same one the hero's own layout turns on.
    Watched rather than read once: a rotated phone and a dragged window are the
    same event to this, and attaching on a resize costs one reseed.
  */
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 64rem)");
    const read = () => setRoomy(wide.matches);
    read();
    wide.addEventListener("change", read);
    return () => wide.removeEventListener("change", read);
  }, []);

  useEffect(() => {
    if (!loaded || !roomy || !host.current || !window.Murmur) return;
    const murmur = window.Murmur.attach(host.current, { carve: true, family });
    return () => murmur.detach();
  }, [loaded, roomy, family]);

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
