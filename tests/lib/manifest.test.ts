import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../../src/app/manifest.ts";

/**
 * The web app manifest (W5-9).
 *
 * Two things worth pinning, and neither is "does it have a name".
 *
 * The **colour** is the one raw hex in the app that is not a document or
 * somebody else's brand: an operating system reads the manifest before any
 * stylesheet exists, so `--ink-900` resolves to nothing there and the value has
 * to be copied. A copy that drifts means a splash screen in a colour the
 * product stopped using, which nobody would ever notice by looking at the app.
 *
 * The **start URL** is the other. `/` is the marketing front door; somebody who
 * put this on their home screen has already decided, and landing them on a
 * sign-up page every morning would be a small insult.
 */

const globals = readFileSync("src/app/globals.css", "utf8");

describe("the manifest", () => {
  it("paints its splash screen in the rail's own ink", () => {
    const railInk = /--ink-900:\s*(#[0-9a-f]{6})/i.exec(globals)?.[1];
    expect(railInk, "`--ink-900` is gone from globals.css — has the rail changed?").toBeTruthy();

    const value = manifest();
    expect(value.background_color).toBe(railInk);
    expect(value.theme_color).toBe(railInk);
  });

  it("opens on the dashboard, not on the front door", () => {
    expect(manifest().start_url).toBe("/dashboard");
  });

  it("keeps the status bar", () => {
    // Standalone, not fullscreen. This is a tool somebody opens for ninety
    // seconds between customers; taking the clock away from a person at work is
    // the wrong trade.
    expect(manifest().display).toBe("standalone");
  });

  it("declares no language", () => {
    // The product is bilingual and the manifest is fetched once with no
    // session. Declaring `tr` would tell the operating system something false
    // for half the users.
    expect(manifest().lang).toBeUndefined();
  });

  it("ships icons that exist", () => {
    for (const icon of manifest().icons ?? []) {
      const path = icon.src.startsWith("/") ? icon.src.slice(1) : icon.src;
      // The icons moved out of Next's `src/app/icon.svg` file convention and
      // into `public/`, because file-based metadata silently overrides the
      // `metadata.icons` object in `layout.tsx` and only one of them can win.
      // A manifest pointing at a 404 is an install with no icon.
      expect(() => readFileSync(`public/${path}`)).not.toThrow();
    }
  });
});
