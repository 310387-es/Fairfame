import { cn } from "@/lib/utils";

/**
 * A star rating, drawn as text.
 *
 * `★☆` are typographic characters, not glyphs from an icon set, so they inherit
 * `currentColor` and `font-size` and stay aligned with the text beside them at
 * any scale. Five repeated 12px Lucide SVGs — which is what this replaces —
 * cost five DOM nodes per row and drift out of the text baseline.
 *
 * These are the only pictographic marks in the product. There are no emoji
 * anywhere, and this is not an invitation to add one.
 *
 * The rendered characters are hidden from assistive technology and the rating
 * is announced as a sentence instead: a screen reader spelling out
 * "black star, white star, white star…" is worse than useless.
 */
export function Stars({
  rating,
  srLabel,
  className,
}: {
  /** 1–5. Rounded to the nearest whole star — there are no half glyphs. */
  rating: number;
  /** e.g. "1 out of 5 stars", already translated. */
  srLabel: string;
  className?: string;
}) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));

  return (
    // 14px, not the 11px this started at. `★` and `☆` are drawn well inside
    // their em box — noticeably smaller than a digit at the same font-size — so
    // matching the surrounding text numerically left them looking shrunken next
    // to it. The tracking is what keeps five of them from reading as one grey
    // smear at this size.
    //
    // Not `font-mono`: Geist Mono has no star glyph, so the browser was already
    // falling back to another family for these two characters — and picking up
    // whatever metrics it happened to have.
    <span className={cn("text-[14px] leading-none tracking-[0.06em]", className)}>
      <span aria-hidden>
        {"★".repeat(filled)}
        {"☆".repeat(5 - filled)}
      </span>
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}
