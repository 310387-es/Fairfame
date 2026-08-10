"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Stars } from "@/components/ds/stars";
import { cn } from "@/lib/utils";

/**
 * The mechanism, as a graph you can interrogate.
 *
 * The first build of this page put the briefing on screen as a document and
 * stopped there. It was judged too static, and the judgement was right: the
 * product's claim is not "here is a report", it is "every line of this report
 * is traceable to a customer who said it" — and a claim about *tracing* has to
 * be traceable on the page, or it is a sentence asking to be believed.
 *
 * So the artefact is drawn as what it actually is: a three-stage pipeline.
 * Reviews arrive, cluster into themes, and become three jobs. Touch any node
 * and its whole lineage lights up — the action, the theme it came from, and the
 * exact customer sentences underneath it. That is the same evidence link the
 * app ships, rendered in space instead of behind a disclosure.
 *
 * **The state is one theme key, not a selection set.** The graph is tripartite
 * and every node belongs to exactly one theme, so "what is related to this" is
 * answered by a string comparison rather than a traversal. That is why the
 * highlight cannot drift out of step with the edges: both read the same field.
 *
 * **Client, and deliberately importing nothing that reaches the database.**
 * Every prop is plain serialisable data and every string arrives translated —
 * a formatter function passed across the RSC boundary is the defect this
 * codebase has now hit three times (P3-T4, P4-T2, and the composer in W4).
 */

export type FlowReview = {
  id: string;
  text: string;
  rating: number | null;
  /**
   * Every theme this review is evidence for — usually one, sometimes two.
   *
   * It was a single key, and a review quoted under two themes was therefore
   * rendered *twice*, with identical stars, in a column six items long. On a
   * page whose thesis is "a figure you cannot click through to is a figure you
   * must take on trust", printing the same customer twice is the cheapest
   * possible way to lose the argument. One node, two edges: a review that
   * belongs to two themes is a better demonstration than a repeat.
   */
  themeKeys: string[];
};

export type FlowTheme = {
  key: string;
  label: string;
  /** Already formatted and pluralised server-side; null when the count is 0. */
  positiveLabel: string | null;
  negativeLabel: string | null;
};

export type FlowAction = {
  position: number;
  text: string;
  themeKey: string;
  themeLabel: string;
};

export type FlowLabels = {
  reviews: string;
  themes: string;
  actions: string;
  /** Spoken hint on each node, naming what selecting it does. */
  hint: string;
  /** Heading above a job's evidence in the stacked layout. */
  evidence: string;
  /** "6 / 14" — this column's scope against the whole week. */
  reviewsCount: string;
  themesCount: string;
  /** Indexed by rating, 1–5. */
  starLabels: string[];
};

type Point = { x: number; y: number };
type Edge = { from: string; to: string; theme: string };

/** Right edge of the source, left edge of the target, both vertically centred. */
function bezier(from: Point, to: Point): string {
  const dx = Math.max(32, (to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

export function PipelineFlow({
  reviews,
  themes,
  actions,
  labels,
}: {
  reviews: FlowReview[];
  themes: FlowTheme[];
  actions: FlowAction[];
  labels: FlowLabels;
}) {
  /** The themes currently lit. A set, because one review can belong to two. */
  const [active, setActive] = useState<string[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<{ d: string; theme: string }[]>([]);

  const register = useCallback((id: string) => {
    return (element: HTMLElement | null) => {
      if (element) nodes.current.set(id, element);
      else nodes.current.delete(id);
    };
  }, []);

  /*
    Edges are measured from the DOM rather than laid out by hand, because the
    columns are ordinary flow content whose heights depend on how long a
    customer's sentence happens to be. Anything hard-coded here would be right
    for one briefing and wrong for the next one the model composes.
  */
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Below `lg` the columns stack, and an edge drawn between two boxes that
    // sit one above the other says nothing. Skip the work rather than hide it.
    if (container.clientWidth < 900) {
      setPaths([]);
      return;
    }

    const origin = container.getBoundingClientRect();
    const anchor = (id: string, side: "left" | "right"): Point | null => {
      const element = nodes.current.get(id);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: (side === "right" ? box.right : box.left) - origin.left,
        y: box.top + box.height / 2 - origin.top,
      };
    };

    const edges: Edge[] = [
      ...reviews.flatMap((review) =>
        review.themeKeys.map((key) => ({
          from: `review-${review.id}`,
          to: `theme-${key}`,
          theme: key,
        })),
      ),
      ...actions.map((action) => ({
        from: `theme-${action.themeKey}`,
        to: `action-${action.position}`,
        theme: action.themeKey,
      })),
    ];

    setPaths(
      edges.flatMap((edge) => {
        const from = anchor(edge.from, "right");
        const to = anchor(edge.to, "left");
        return from && to ? [{ d: bezier(from, to), theme: edge.theme }] : [];
      }),
    );
  }, [reviews, actions]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // Every node too: a reflow inside one card moves the anchors of its
    // neighbours without changing the container's own box.
    nodes.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [measure]);

  // Fonts land after first paint and change every box in the graph.
  useEffect(() => {
    if (!document.fonts?.ready) return;
    void document.fonts.ready.then(measure);
  }, [measure]);

  /** Lit when this node shares any theme with the active set. */
  const lit = (keys: string[]) => active === null || keys.some((key) => active.includes(key));

  const nodeProps = (keys: string[]) => ({
    onMouseEnter: () => setActive(keys),
    onMouseLeave: () => setActive(null),
    onFocus: () => setActive(keys),
    onBlur: () => setActive(null),
    /*
      Non-selected nodes fade, and the selected set additionally takes an
      indigo ring — never colour or opacity alone (docs/15 §1.3, WCAG 1.4.1).
      The fade is transient and entirely under the reader's pointer or focus:
      moving away restores full contrast, and nothing is only legible in the
      undimmed state.
    */
    className: cn(
      "group/node w-full rounded-lg border bg-card p-3 text-left transition-[opacity,box-shadow,border-color] duration-(--duration-base) ease-(--ease-out) focus-visible:outline-none",
      lit(keys) ? "border-line opacity-100" : "border-line opacity-45",
      active !== null && lit(keys) && "border-indigo-100 shadow-[var(--elevation-selected)]",
    ),
  });

  const reviewsFor = (theme: string) =>
    reviews.filter((review) => review.themeKeys.includes(theme));

  /*
    In the stacked layout, each customer appears once.

    The wide graph solved this with one node and two edges — a review belonging
    to two themes is drawn once and lights from either. Stacking has no edges,
    so the same quote was printed in full under two different jobs, with the
    same stars, a few hundred pixels apart. That is the duplication this
    component was rewritten to remove, reintroduced in the branch nobody
    measured.

    First job that cites a review keeps it. A later job shows whatever is still
    unseen, which for this corpus is always at least one quote — and if it ever
    were not, showing nothing is still better than showing the reader the same
    sentence twice and asking them to believe it is evidence for two things.
  */
  const claimed = new Set<string>();
  const unseenReviewsFor = (theme: string) =>
    reviewsFor(theme).filter((review) => {
      if (claimed.has(review.id)) return false;
      claimed.add(review.id);
      return true;
    });

  return (
    <>
      {/*
        Below `lg`, one job at a time with its evidence underneath.

        The graph does not survive being stacked: three columns become twelve
        cards in a single file, the edges that carry the whole meaning cannot be
        drawn between boxes sitting one above another, and the reader is left
        scrolling a list whose relationships are invisible. So the small screen
        gets the same information in the shape a phone can actually read — the
        job, the theme it came from, and the customers underneath it — rather
        than a squeezed version of a layout that needs width to mean anything.

        Nothing is hidden here that the wide layout shows: the evidence is open
        by default, because a phone reader should not have to hunt for the proof
        that is the entire point.
      */}
      <ol className="flex flex-col gap-4 lg:hidden">
        {actions.map((action) => {
          const unseen = unseenReviewsFor(action.themeKey);
          return (
            <li key={action.position} className="rounded-lg border border-line bg-card p-4">
              <div className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-meta font-semibold text-white"
                >
                  {action.position}
                </span>
                <div className="min-w-0">
                  <p className="text-body leading-relaxed text-pretty">{action.text}</p>
                  <p className="mt-1 text-meta text-faint">{action.themeLabel}</p>
                </div>
              </div>

              {unseen.length > 0 ? (
                <div className="mt-4 border-t border-line-soft pt-3">
                  <p className="text-eyebrow text-faint uppercase">{labels.evidence}</p>
                  <ul className="mt-2 flex flex-col gap-3">
                    {unseen.map((review) => (
                      <li key={review.id}>
                        {review.rating === null ? null : (
                          <Stars
                            rating={review.rating}
                            size="sm"
                            srLabel={labels.starLabels[review.rating] ?? ""}
                            className="mb-1"
                          />
                        )}
                        <p className="text-copy leading-relaxed text-pretty text-ink-600 italic">
                          {review.text}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div ref={containerRef} className="relative hidden lg:block">
        {/* Decoration: the same relationships are in the DOM as text, and every
          node states its theme in its own accessible name. */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          {paths.map((path, index) => (
            <path
              key={index}
              d={path.d}
              fill="none"
              strokeWidth={1.5}
              className={cn(
                "transition-[stroke,opacity] duration-(--duration-base) ease-(--ease-out)",
                /* `--line` is a *card hairline* on white and disappears as a
                 stroke across open canvas. `--graphic-faint` is the token for
                 non-text marks — axis ticks, legend dots — which is exactly
                 what an edge is. */
                active === null
                  ? "stroke-graphic-faint opacity-70"
                  : active.includes(path.theme)
                    ? "stroke-indigo-600 opacity-100"
                    : "stroke-graphic-faint opacity-20",
              )}
            />
          ))}
        </svg>

        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,0.8fr)_minmax(0,1.1fr)] lg:gap-x-14">
          <Column title={labels.reviews} count={labels.reviewsCount}>
            {reviews.map((review) => (
              <li key={review.id}>
                <button
                  type="button"
                  ref={register(`review-${review.id}`)}
                  {...nodeProps(review.themeKeys)}
                >
                  <span className="sr-only">{labels.hint}</span>
                  {review.rating === null ? null : (
                    <Stars
                      rating={review.rating}
                      size="sm"
                      srLabel={labels.starLabels[review.rating] ?? ""}
                      className="mb-1.5"
                    />
                  )}
                  <span className="line-clamp-3 text-copy leading-relaxed text-pretty text-ink-600 italic">
                    {review.text}
                  </span>
                </button>
              </li>
            ))}
          </Column>

          <Column title={labels.themes} count={labels.themesCount}>
            {themes.map((theme) => (
              <li key={theme.key}>
                <button
                  type="button"
                  ref={register(`theme-${theme.key}`)}
                  {...nodeProps([theme.key])}
                >
                  <span className="sr-only">{labels.hint}</span>
                  <span className="text-title">{theme.label}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1.5 text-meta">
                    {theme.positiveLabel ? (
                      <span className="rounded-sm bg-state-positive-bg px-1.5 py-0.5 font-semibold text-state-positive-text">
                        {theme.positiveLabel}
                      </span>
                    ) : null}
                    {theme.negativeLabel ? (
                      <span className="rounded-sm bg-state-negative-bg px-1.5 py-0.5 font-semibold text-state-negative-text">
                        {theme.negativeLabel}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </Column>

          <Column title={labels.actions}>
            {actions.map((action) => (
              <li key={action.position}>
                <button
                  type="button"
                  ref={register(`action-${action.position}`)}
                  {...nodeProps([action.themeKey])}
                >
                  <span className="sr-only">{labels.hint}</span>
                  <span className="flex gap-3">
                    <span
                      aria-hidden
                      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-meta font-semibold text-white"
                    >
                      {action.position}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-copy leading-relaxed text-pretty">
                        {action.text}
                      </span>
                      <span className="mt-1 block text-meta text-faint">{action.themeLabel}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </Column>
        </div>
      </div>
    </>
  );
}

function Column({
  title,
  count,
  children,
}: {
  title: string;
  /**
   * "6 / 14" — what this column shows against what the week held.
   *
   * The stat row below the graph reports the whole week (14 reviews, 6 themes)
   * while the graph shows only the evidence behind the three jobs. Both were
   * true and neither said so, on a page that tells the reader to count. The
   * column now states its own scope.
   */
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-3 flex items-baseline gap-2 text-eyebrow text-faint uppercase">
        <span>{title}</span>
        {count ? <span className="font-mono normal-case tabular-nums">{count}</span> : null}
      </p>
      <ul className="flex flex-col gap-3">{children}</ul>
    </div>
  );
}
