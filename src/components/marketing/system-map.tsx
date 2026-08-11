"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The system map: every source flowing into the seal, every finished thing
 * flowing out.
 *
 * The page's other sections argue one feature at a time; this is the only
 * place it says *these are one system*, which is the real claim behind the
 * word "platform" and the thing a grid of cards cannot make. Sources enter on
 * the left, the seal reads them, finished work leaves on the right.
 *
 * ## It is drawn on ink, and that is a composition decision
 *
 * Everything above it in this section is a white card on paper — nine of them
 * — and a tenth white card reads as a tenth feature rather than as the thing
 * that ties the other nine together. On ink it is a different kind of object:
 * a band, like the closing call to action, which is the page's other "this is
 * the whole of it" moment. The amber flow along the edges is also the one
 * treatment that needs a dark ground to be visible at all — on white it was a
 * pale dotted line, and it is meant to read as current moving through wires.
 *
 * ## Why it is hand-drawn SVG and not a graph library
 *
 * React Flow was the alternative and does not earn its bundle here: this graph
 * never pans, never zooms, has no drag, no layout algorithm, and ten nodes
 * whose positions are the literals below. That is a picture, not a canvas — so
 * it ships as SVG rather than as a dependency carried by one page.
 *
 * ## The labels lay themselves out, and that is the whole design
 *
 * A node's pill has to fit its label, and the label is translated: "QR &
 * collection page" and "QR ve toplama sayfası" are different widths, and both
 * differ again before the font loads and after.
 *
 * The landing concept solved this by measuring each `<text>` with `getBBox()`
 * and sizing a `<rect>` from the result. **Ported directly into React that is
 * an infinite loop** — the measurement writes state, the state re-renders the
 * node, the re-render re-runs the measurement — and it is worth recording that
 * it passed every unit test, the build, and the browser contrast and touch
 * suites before failing on the first human look at the page.
 *
 * So nothing is measured. Each label is a `<foreignObject>` holding an
 * ordinary inline-block span, which sizes to its own text the way HTML always
 * has: correct in both languages, correct before and after the webfont, and
 * with no measure-render cycle to get wrong.
 */

/**
 * The seal's radius, in viewBox units.
 *
 * The wires start at the seal's edge, so this is also a lever on their length:
 * every unit off the radius is a unit added to each of the ten runs.
 */
const SEAL = 38;
const CENTRE = { x: 460, y: 140 };

/**
 * Where a row's `foreignObject` ends — and so where the curve takes over.
 *
 * The node no longer fills this. Each pill is as wide as its own words and sits
 * against the outer margin; a **lead line** fills whatever is left of the row,
 * from the pill's edge to `LEAD`, where the bezier picks it up.
 *
 * That is the whole trick, and it resolves three constraints that had been
 * knocking each other over for four revisions:
 *
 *   - **the node hugs its label**, so "Google" is not a wide box with an empty
 *     right half;
 *   - **the diagram still spans the card**, because the pills sit at x=0 and
 *     x=920 rather than being pushed inwards to meet the wires;
 *   - **every wire still touches its node**, because the lead is a flex child
 *     that takes the remaining width — HTML measures it, so nothing here has
 *     to, and the measure-render loop that broke this component originally
 *     stays gone.
 *
 * A label longer than `LEAD` shrinks the lead to nothing and then ellipsises
 * rather than overflowing the frame.
 */
const LEAD = 250;

/** The rows both columns share, top to bottom. */
const ROWS = [32, 86, 140, 194, 248] as const;

/** Keys written out in full so `scripts/check-i18n.mts` can see them. */
const SOURCES = [
  "map.google",
  "map.whatsapp",
  "map.instagram",
  "map.qr",
  "map.moreSources",
] as const;

const OUTPUTS = ["map.analysis", "map.replies", "map.plan", "map.showcase", "map.pdf"] as const;

/**
 * A node's whole wire, as one path: a straight run along its row, then a curve
 * to the seal.
 *
 * **One path, not two, and that is the point.** The travelling dash is a
 * `stroke-dashoffset` animation over the path's own length, so a straight lead
 * drawn separately from the curve would carry its own independent phase — the
 * dots would arrive at the join and stutter. Joined, the pattern runs from the
 * card's edge to the seal without a seam.
 *
 * The straight run starts at the card edge and passes *behind* the node, which
 * is why the pill is opaque: the visible line begins exactly at the pill's edge
 * whatever the label's width, with nothing measuring anything. That was the
 * whole difficulty here, and it turns out to be solved by paint order rather
 * than by arithmetic.
 */
function wirePath(row: number, side: "start" | "end"): string {
  const mid = (LEAD + CENTRE.x) / 2;

  return side === "start"
    ? `M0,${row} L${LEAD},${row} C${mid},${row} ${mid},${CENTRE.y} ${CENTRE.x - SEAL},${CENTRE.y}`
    : `M${CENTRE.x + SEAL},${CENTRE.y} C${920 - mid},${CENTRE.y} ${920 - mid},${row} ${920 - LEAD},${row} L920,${row}`;
}

export function SystemMap() {
  const t = useTranslations("marketing");
  const [hot, setHot] = useState<string | null>(null);

  const label = (key: string, row: number, side: "start" | "end") => {
    const lit = hot === key;

    return (
      <foreignObject
        key={key}
        x={side === "start" ? 0 : 920 - LEAD}
        y={row - 15}
        width={LEAD}
        height={30}
      >
        {/* No `xmlns` on the div: this document is served as HTML, not XHTML,
            so the parser puts `foreignObject` children in the HTML namespace
            already — and React's types reject the attribute for that reason. */}
        <div
          onPointerEnter={() => setHot(key)}
          onPointerLeave={() => setHot(null)}
          /*
            The pill does not dim with its wire, and that is not an oversight.

            The line now runs *behind* the node — that is what makes it start at
            the pill's edge without measuring anything — so fading the pill
            makes the dashes show straight through the label. Only the wires
            drop to 25%; one white pill among nine muted ones is already an
            unmistakable highlight, and the node stays readable while the
            reader is following somebody else's connection.
          */
          className={cn("flex h-[30px] items-center", side === "end" && "justify-end")}
        >
          {/*
            The hit area is the whole row rather than the pill alone, and that
            is honest here: the lead line is part of the node's own connection,
            so pointing anywhere along it is pointing at that node. It also
            makes a 70-unit target into a 250-unit one.
          */}
          <span
            className={cn(
              "max-w-full cursor-default overflow-hidden rounded-lg border px-3 py-1 text-meta font-semibold text-ellipsis whitespace-nowrap transition-colors duration-150",
              lit
                ? "border-white bg-brand-ink text-white"
                : "border-ink-600 bg-brand-ink text-on-ink-muted",
            )}
          >
            {t(key)}
          </span>
        </div>
      </foreignObject>
    );
  };

  const wire = (key: string, d: string) => {
    const lit = hot === key;
    /* The dimming is what makes the highlight legible: raising one edge above
       nine identical ones barely reads, and dropping the other nine reads
       immediately. Nothing moves — only opacity and stroke. */
    const dimmed = hot !== null && !lit;

    return (
      <g
        key={`edge-${key}`}
        className={cn("transition-opacity duration-150", dimmed && "opacity-25")}
      >
        <path
          d={d}
          className={cn("fill-none transition-colors", lit ? "stroke-white" : "stroke-ink-600")}
          strokeWidth={lit ? 2 : 1.5}
        />
        <path
          d={d}
          className={cn("map-flow fill-none", lit ? "stroke-white" : "stroke-amber-500")}
          strokeWidth={lit ? 2 : 1.5}
          strokeDasharray="3 8"
          strokeLinecap="round"
        />
      </g>
    );
  };

  return (
    <div className="mt-3.5 rounded-2xl bg-brand-rail p-6">
      <p className="text-eyebrow text-on-ink-muted uppercase">{t("map.title")}</p>
      <p className="mt-0.5 mb-2.5 text-copy text-on-ink-muted">{t("map.hint")}</p>

      {/*
        One image with one description. Every label in it is also a heading, a
        card or a nav item elsewhere on this page, so exposing ten more text
        nodes would be ten repetitions of what a screen reader has just read —
        the picture's *arrangement* is the only new information here, and that
        is what the label says. `role="img"` also makes the node a leaf, which
        is what keeps the `foreignObject` spans out of the tree.

        `overflow-x-auto` rather than a scaled copy: at 390px a ten-node graph
        shrunk to fit is a graph nobody can read. Scrolling it sideways keeps
        the labels at their real size.
      */}
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 920 300"
          role="img"
          aria-label={`${t("map.title")} ${t("map.hint")}`}
          className="block h-auto w-full min-w-[680px]"
        >
          {SOURCES.map((key, index) => wire(key, wirePath(ROWS[index]!, "start")))}
          {OUTPUTS.map((key, index) => wire(key, wirePath(ROWS[index]!, "end")))}

          {/* The seal is the shipped file placed at size, never a redraw — the
              shared crossbar is the identity (docs/24 §2). The on-dark variant,
              because this band is ink: the white disc is the mark's own answer
              to a dark ground, and tinting the light one would be a redraw. */}
          <image
            href="/brand/fairfame-symbol-on-dark.svg"
            x={CENTRE.x - SEAL}
            y={CENTRE.y - SEAL}
            width={SEAL * 2}
            height={SEAL * 2}
          />

          {SOURCES.map((key, index) => label(key, ROWS[index]!, "start"))}
          {OUTPUTS.map((key, index) => label(key, ROWS[index]!, "end"))}
        </svg>
      </div>
    </div>
  );
}
