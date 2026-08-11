import { cn } from "@/lib/utils";

/**
 * The Fairfame mark (docs/24-brand-guidelines.md §2).
 *
 * **The identity is a file, not a drawing.** The seal's two f's share a single
 * crossbar — that is the whole idea of the mark, two words fused — and a
 * component that re-draws it with its own `<path>` has drawn a different logo
 * the first time somebody adjusts a curve. So nothing here describes geometry:
 * the artwork ships in `brand/`, is copied verbatim into `public/brand/`, and
 * this file only says which variant and how big. `tests/lib/brand-assets.test.ts`
 * fails if a copy drifts from its source.
 *
 * This replaced the Revira "R" monogram, which was drawn in code for a reason
 * that no longer applies — the old reference set the letter as SVG `<text>`,
 * which would have depended on a font being installed. The Fairfame wordmark is
 * already cut to outlines in the file, so serving the file is both the safest
 * and the most faithful option.
 *
 * ## Two surfaces, two files
 *
 * `tone` is the surface the logo sits *on*, not the colour it is: `"ink"` picks
 * the white-seal variant for the rail and the briefing bar, `"paper"` the
 * ink-seal variant for every light surface. It is a file swap rather than a
 * `currentColor` trick because the wordmark's full stop stays amber in both,
 * and an inherited colour would have flattened it.
 */

const LOCKUP = {
  paper: "/brand/fairfame-lockup.svg",
  ink: "/brand/fairfame-lockup-on-dark.svg",
} as const;

const SEAL = {
  paper: "/brand/fairfame-symbol.svg",
  ink: "/brand/fairfame-symbol-on-dark.svg",
} as const;

export type LogoTone = keyof typeof LOCKUP;

/**
 * The seal alone. Holds at 16px, which is the documented floor; below 24px the
 * brand rules say the seal is the *only* correct form, so a caller that needs
 * something small wants this rather than a shrunken lockup.
 *
 * `title` makes it an image with a name; without one it is decorative and
 * hidden, which is right whenever the product's name is already in the text
 * beside it.
 */
export function LogoMark({
  className,
  tone = "paper",
  title,
  size,
}: {
  className?: string;
  tone?: LogoTone;
  title?: string;
  /**
   * Edge length in pixels, for a caller that sizes in numbers rather than in
   * classes — `ProviderMark` is the one, because every mark on that screen is
   * drawn to one `size` prop and ours must line up with the rest.
   */
  size?: number;
}) {
  return (
    /* A plain image element, not `next/image`: the artwork is a static SVG
       served from `public/`, so there is nothing for the optimizer to resize or
       re-encode, and `next/image` would only wrap a mark whose size every call
       site already sets in layout rules it does not need.

       Written out in words rather than as the tag, because a design scanner
       reading this file cannot tell a comment from markup and reported the
       sentence as an image with no `src`. */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={SEAL[tone]}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      width={size ?? 44}
      height={size ?? 44}
      className={cn("shrink-0", className)}
    />
  );
}

/**
 * Seal plus wordmark — the lockup, for headers, the rail and auth screens.
 *
 * Sized by **height**, because the file carries its own proportions (241 × 58)
 * and the wordmark must not be stretched. `h-*` on `className` sets it; the
 * width follows. The minimum is 28px tall.
 */
export function Logo({ className, tone = "paper" }: { className?: string; tone?: LogoTone }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see `LogoMark`.
    <img
      src={LOCKUP[tone]}
      alt="Fairfame"
      width={241}
      height={58}
      className={cn("w-auto shrink-0", className)}
    />
  );
}
