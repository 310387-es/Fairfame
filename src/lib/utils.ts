import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The system's own `text-*` sizes.
 *
 * **Why this file needs configuring at all, and what it was silently breaking.**
 *
 * Tailwind writes both font-size and text-colour into one `text-*` namespace,
 * and `tailwind-merge` tells them apart from a built-in table of Tailwind's
 * *default* scale. Every size in this product is a custom `@theme` token
 * (`--text-title`, `--text-copy`, …) and so is every ink (`--color-faint`,
 * `--color-ink-400`, …), so `tailwind-merge` recognised neither — it filed both
 * as the same ambiguous group and applied last-one-wins.
 *
 * The result was that **a size followed by a colour deleted the size**:
 *
 *     cn("text-eyebrow text-faint uppercase")  ->  "text-faint uppercase"
 *     cn("text-copy", "text-muted-foreground") ->  "text-muted-foreground"
 *     cn("text-title", "text-foreground")      ->  "text-foreground"
 *
 * The class simply never reached the DOM, so the element fell back to the
 * inherited 16px. `Eyebrow` — whose entire job is to be 10.5px so that "the
 * number wins" against its label — was rendering at 16px on every metric tile
 * in the product. Nothing failed: no build error, no console warning, correct
 * markup, correct colour, and a type scale quietly thrown away wherever a
 * component happened to compose a size with an ink.
 *
 * It is also why the same label looked right in some places and wrong in
 * others: `ChipGroup` writes its classes as one literal string, which never
 * goes through the merge, while `Eyebrow` composes them through `cn` and lost
 * its size. Two renderings of one token, decided by whether a component used a
 * template or a helper.
 *
 * Listing the tokens here is what makes the two groups distinguishable again.
 * **Adding a `--text-*` size or a `--color-*` ink to `globals.css` means adding
 * it here too**; the alternative is that it works everywhere except where it is
 * merged, which is the failure mode this comment exists to stop repeating.
 */
const FONT_SIZES = [
  "hero",
  "display",
  "metric",
  "metric-lg",
  "lead",
  "title",
  "body",
  "copy",
  "meta",
  "eyebrow",
] as const;

/**
 * The system's own `text-*` inks.
 *
 * Only the tokens that are *text colours*. A surface token that happens to be
 * usable as an ink elsewhere (`bg-state-rating-bg`) does not belong here —
 * this list decides what `tailwind-merge` treats as a colour in the `text-*`
 * namespace, and nothing else.
 */
const TEXT_COLORS = [
  "faint",
  "graphic-faint",
  "foreground",
  "muted-foreground",
  "card-foreground",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary-foreground",
  "accent-foreground",
  "destructive",
  "destructive-ink",
  "positive",
  "positive-ink",
  "positive-foreground",
  "rating",
  "rating-ink",
  "rating-1",
  "rating-2",
  "rating-3",
  "rating-4",
  "rating-5",
  "sentiment-positive",
  "sentiment-neutral",
  "sentiment-negative",
  "ink-400",
  "ink-500",
  "ink-600",
  "ink-800",
  "ink-900",
  "indigo-600",
  "indigo-700",
  "amber-500",
  "amber-ink",
  "on-ink",
  "on-ink-muted",
  "cta-brief-text",
  "state-accent-text",
  "state-negative-text",
  "state-positive-text",
  "state-rating-text",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...FONT_SIZES] }],
      "text-color": [{ text: [...TEXT_COLORS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
