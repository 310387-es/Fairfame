import { cn } from "@/lib/utils";

/**
 * A star rating, drawn as text.
 *
 * `★☆` are typographic characters, not glyphs from an icon set, so they inherit
 * `font-size` and stay aligned with the text beside them at any scale. Five
 * repeated 12px Lucide SVGs — which is what this replaces — cost five DOM nodes
 * per row and drift out of the text baseline.
 *
 * These are the only pictographic marks in the product. There are no emoji
 * anywhere, and this is not an invitation to add one.
 *
 * **The stars are amber, and that is the component's job rather than the call
 * site's.** They used to inherit `currentColor`, which meant that in a product
 * about ratings the rating was drawn in body-text ink almost everywhere — and
 * in exactly one place (`review-list.tsx`) somebody had noticed and passed
 * `text-state-rating-text` by hand. Two treatments for one thing, decided per
 * caller, is the shape a design system exists to remove. Amber is the brand's
 * rating colour (`--rating`, docs/08 §Palette); a star is the only mark that
 * gets it by default.
 *
 * Filled and empty are separate spans so the empty ones can drop to a non-text
 * grey. `--graphic-faint` is right for them and would not be legal for text:
 * they are a *track*, not content — the rating is announced as a sentence.
 *
 * The rendered characters are hidden from assistive technology and the rating
 * is announced as a sentence instead: a screen reader spelling out
 * "black star, white star, white star…" is worse than useless.
 */

/**
 * 14px is the row default and 17px is for a heading — a review's own rating in
 * the detail pane, a branch's rating in a table it is the subject of. `sm` is
 * for a rating that qualifies something else, like a name in an activity feed.
 *
 * Not `font-mono`: Geist Mono has no star glyph, so the browser was already
 * falling back to another family for these two characters — and picking up
 * whatever metrics it happened to have.
 */
const SIZES = {
  sm: "text-[12px]",
  default: "text-[14px]",
  lg: "text-[17px]",
} as const;

export function Stars({
  rating,
  srLabel,
  size = "default",
  className,
}: {
  /** 1–5. Rounded to the nearest whole star — there are no half glyphs. */
  rating: number;
  /** e.g. "1 out of 5 stars", already translated. */
  srLabel: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));

  return (
    // The tracking is what keeps five of them from reading as one smear at this
    // size — `★` and `☆` are drawn well inside their em box, noticeably smaller
    // than a digit at the same font-size.
    <span
      className={cn("leading-none tracking-[0.06em] whitespace-nowrap", SIZES[size], className)}
    >
      <span aria-hidden className="text-rating">
        {"★".repeat(filled)}
      </span>
      <span aria-hidden className="text-graphic-faint">
        {"☆".repeat(5 - filled)}
      </span>
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}
