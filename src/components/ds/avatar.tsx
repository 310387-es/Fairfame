import { cn } from "@/lib/utils";

/**
 * Somebody's initials in a circle (W4.3).
 *
 * There is no photograph anywhere in this product and there is not going to be
 * one: a review's author is a name a platform handed us, a teammate has no
 * upload, and `docs/15` §7 rules out imagery altogether — "the product's
 * imagery is its data". So an avatar here is a monogram, which is what the
 * user menu has been drawing inline since Phase 0. This is that, extracted, so
 * the activity timeline and the menu cannot drift into two shapes.
 *
 * **The colour is derived from the name**, not random and not assigned. Two
 * entries by the same customer get the same circle, which is the only property
 * that makes a column of these readable — a timeline where "Zeynep Kaya"
 * changes colour between Tuesday and Thursday is a timeline that looks like two
 * people. A tiny hash over the palette is enough; there is no state to keep and
 * nothing to migrate if the palette changes.
 */

/**
 * Deliberately the chart palette rather than the state colours. These say
 * "different person", not "good" or "bad", and reaching for
 * `--sentiment-negative` here would put a red circle beside a five-star review.
 */
const TONES = [
  "bg-chart-1/15 text-chart-1",
  "bg-chart-2/15 text-chart-2",
  "bg-chart-3/15 text-chart-3",
  "bg-chart-4/15 text-chart-4",
  "bg-chart-5/15 text-chart-5",
] as const;

export function initialsOf(name: string | null): string {
  if (name === null) return "?";

  const letters = name
    .trim()
    .split(/\s+/)
    .map((part) => [...part][0])
    .filter((letter): letter is string => letter !== undefined)
    .slice(0, 2)
    .join("");

  // `toLocaleUpperCase("tr")`: a lowercase "i" in a Turkish name uppercases to
  // "İ", not "I". The same trap `src/seo/slug.ts` documents from the other
  // direction, and getting it wrong here spells somebody's initial wrong.
  return letters === "" ? "?" : letters.toLocaleUpperCase("tr");
}

function toneFor(name: string | null): string {
  if (name === null) return "bg-surface-sunken text-ink-400";

  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) % 9973;

  return TONES[hash % TONES.length] ?? TONES[0];
}

export function Avatar({
  name,
  className,
}: {
  /** Null renders a neutral placeholder — an event with no person behind it. */
  name: string | null;
  className?: string;
}) {
  return (
    <span
      // The name is always beside it as text, so announcing the monogram too
      // would read every entry's person twice.
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full text-meta font-semibold",
        toneFor(name),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
