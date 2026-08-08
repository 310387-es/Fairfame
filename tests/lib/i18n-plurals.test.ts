import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";

/**
 * English messages have to survive the number one.
 *
 * A count interpolated into a sentence is the easiest thing in a product to get
 * wrong, because it is right on every screen the person who wrote it looked at.
 * `{used} locations` reads perfectly at 3 and reads as a bug at 1 — and 1 is the
 * value a new account sees, on its first visit, on the screen it lands on. This
 * codebase had **twenty-nine** of them, including `Trial · {days} days left`,
 * which sits in the rail on every screen and says "1 days left" on the day it
 * matters most, and `{rating} stars and up`, a dropdown option that reads
 * "1 stars and up" permanently because that value never changes.
 *
 * The rule is only checkable for English. Turkish has no numeral agreement — a
 * noun after a number stays singular, so `{used} şube` is correct at every value
 * and every one of those twenty-nine Turkish strings was already right. That
 * asymmetry is the trap: the locale most of this product's customers read is the
 * one that never shows the mistake, so nothing on screen in Türkiye would ever
 * have surfaced it.
 *
 * What is checked is deliberately narrow: format every message with each of its
 * arguments set to 1, and fail on `1 <word>s` in the output. It cannot see a
 * missing plural where the noun is irregular, and it does not try — a check that
 * guesses at grammar produces exemptions nobody trusts. It catches the regular
 * case, which is the case that occurs.
 */

function flatten(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node === null || typeof node !== "object") return [];

  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, path === "" ? key : `${path}.${key}`),
  );
}

/** Argument names appearing outside a `plural`/`select` block, at value 1. */
function argumentsOf(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*[,}]/g)].map((m) => m[1]!)),
  ];
}

/**
 * Messages where the "1" the test injected is not a count at all.
 *
 * Every argument is set to 1, including the ones that hold names — so a title
 * built from a business and a branch renders "1 — 1 reviews" and looks like a
 * violation. A per-key list rather than a cleverer substitution, because
 * guessing which arguments are numeric from their names is exactly the kind of
 * rule that is wrong once and then trusted forever.
 */
const NOT_A_COUNT: Record<string, string> = {
  "publicPage.metaTitle": "`{business} — {location} reviews` — both arguments are names.",
  "locations.hours.openAt": "`{day} opens at` — the argument is a weekday name.",
  "locations.hours.closeAt": "`{day} closes at` — the argument is a weekday name.",
};

describe("English count messages", () => {
  const messages = flatten(en);
  // The catalogue is typed literally, so `t` only accepts known key literals.
  // This walks every key at runtime, which is the whole point.
  const t = createTranslator({ locale: "en", messages: en }) as unknown as (
    key: string,
    values: Record<string, number>,
  ) => string;

  it("reads correctly when the number is one", () => {
    const wrong: string[] = [];

    for (const [key, message] of messages) {
      if (key in NOT_A_COUNT) continue;

      // A message that already carries an ICU plural has been thought about,
      // and its `=1` branch is the author's decision. `1 needs attention` is
      // correct English and this check must not argue with it.
      if (message.includes(", plural,")) continue;

      const names = argumentsOf(message);
      if (names.length === 0) continue;

      const values = Object.fromEntries(names.map((name) => [name, 1]));

      let rendered: string;
      try {
        rendered = t(key, values);
      } catch {
        // Rich-text tags and date/number skeletons that need a real value.
        // Those are not count sentences, so skipping them loses nothing.
        continue;
      }

      // `(?<!s)s\b`: a word ending in a double s is not a plural. "1 address
      // could not be reached" is correct, and matching it would have meant an
      // exemption for a message that never had anything wrong with it.
      for (const match of rendered.matchAll(/\b1 ([a-z]+(?<!s)s)\b/g)) {
        const word = match[1]!;
        // Verbs agreeing with a singular subject, not nouns being counted.
        if (/^(has|was|is|does|its|this|goes|says|needs|gets|was)$/.test(word)) continue;
        wrong.push(`${key}: "${rendered.trim()}"`);
        break;
      }
    }

    expect(
      wrong,
      `These English messages render a plural noun after the number one. Wrap ` +
        `the count in an ICU plural — {count, plural, =1 {1 review} other {# ` +
        `reviews}} — rather than interpolating it bare. The Turkish string ` +
        `almost certainly needs no change, which is exactly why this is easy to ` +
        `miss:\n  ${wrong.join("\n  ")}`,
    ).toEqual([]);
  });
});
