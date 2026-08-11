import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import tr from "@/i18n/messages/tr.json";
import { LOCALES, type Locale } from "@/i18n/config";

/**
 * Every message actually compiles (P2-T9).
 *
 * `pnpm check:i18n` proves a key exists in both catalogues and is used
 * somewhere; `i18n.test.ts` proves the two languages declare the same
 * placeholders. Neither runs the message through ICU, and that is a real gap —
 * a string can satisfy both and still throw the moment it renders.
 *
 * It is not hypothetical. This phase shipped `"Use {{author}} to fill in the
 * details"` into a translation, where `{` is ICU placeholder syntax; both
 * existing checks passed and the settings screen would have failed at render.
 * The bug was caught by opening the page, which is not a test.
 *
 * Formatted through **next-intl itself**, not a bare parser. The parser would
 * prove the syntax is legal; this proves the thing the app actually calls
 * produces a string — which additionally catches a plural whose categories the
 * locale does not accept, and an argument the message needs but nobody passes.
 */

const CATALOGUES: Record<Locale, Record<string, unknown>> = { en, tr };

type Message = { path: string; text: string };

function flatten(messages: Record<string, unknown>, prefix = ""): Message[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") return [{ path, text: value }];
    if (value && typeof value === "object") {
      return flatten(value as Record<string, unknown>, path);
    }
    return [];
  });
}

/**
 * ICU argument names — `days` in `{days}`, `count` in `{count, plural, …}`.
 *
 * The identifier must be followed by a comma or a closing brace, which is what
 * excludes a plural's sub-messages: those are brace-delimited prose, not
 * variables.
 */
function argumentsOf(text: string): string[] {
  return [...text.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((match) => match[1]!);
}

/**
 * A plausible value per argument.
 *
 * Numbers, because the arguments most likely to be picky are the numeric ones:
 * a `plural` or a `number` given a string is exactly the mismatch worth
 * catching. A `Date` is supplied for anything that reads like a time, since
 * `date`/`time` formats reject a number.
 */
function valuesFor(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const name of argumentsOf(text)) {
    const usage = new RegExp(`\\{\\s*${name}\\s*,\\s*(\\w+)`).exec(text)?.[1];
    values[name] =
      usage === "date" || usage === "time"
        ? new Date("2026-08-04T09:00:00Z")
        : usage === "plural" || usage === "number" || usage === "selectordinal"
          ? 3
          : "x";
  }

  // Rich-text tags need a handler each, or the message throws for want of one.
  for (const tag of tagsOf(text)) {
    values[tag] = (chunks: unknown) => chunks;
  }

  return values;
}

/**
 * Rich-text tag names — `big` in `<big>{amount}</big>`.
 *
 * These exist because a price line's words do not sit in the same order in
 * every language: English is `from $89 / month`, Turkish is `aylık $89'dan`,
 * and only the translation can say which part is the figure. `t.rich` lets it,
 * and a message that uses it must be rendered through `.rich` — plain `t()`
 * reports a missing handler and returns the key, which is what this file exists
 * to catch. Without this the check could not validate a tag-bearing message at
 * all, so the first one added would have failed here rather than in the page.
 */
function tagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/<(\w+)>/g)].map((match) => match[1]!))];
}

describe.each(LOCALES)("the %s catalogue", (locale) => {
  const messages = flatten(CATALOGUES[locale]);

  it("has messages to check", () => {
    // A guard against the whole suite passing because the import resolved to
    // nothing — the failure mode that makes a green run meaningless.
    expect(messages.length).toBeGreaterThan(100);
  });

  it("renders every message without an ICU error", () => {
    const failures: string[] = [];

    for (const message of messages) {
      const t = createTranslator({
        locale,
        messages: CATALOGUES[locale],
        // next-intl swallows errors and returns the key by default, so without
        // this a broken message looks like a passing test.
        onError: (error) => failures.push(`${message.path}: ${error.message}`),
      });

      // The key is a runtime string; the typed API wants a literal drawn from
      // the catalogue, which is precisely what cannot be known in a loop.
      //
      // `.rich` for a message carrying tags, plain `t()` for the rest — the
      // same call the app would make, which is the whole point of formatting
      // through next-intl rather than through a bare parser.
      const call = tagsOf(message.text).length > 0 ? t.rich : t;
      (call as unknown as (key: string, values: Record<string, unknown>) => unknown)(
        message.path,
        valuesFor(message.text),
      );
    }

    expect(failures).toEqual([]);
  });

  it("is a check that can actually fail", () => {
    // The guard on the guard. `onError` is how next-intl reports a bad message
    // — it returns the key and carries on — so a test that forgot to pass it
    // would go green on a catalogue full of broken strings. This asserts the
    // wiring by feeding it the exact bug this phase shipped.
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: { broken: "Use {{author}} to fill in the details." },
      onError: (error) => errors.push(error.message),
    });

    (t as unknown as (key: string, values: Record<string, unknown>) => string)("broken", {
      author: "Selin",
    });

    expect(errors.join()).toContain("MALFORMED_ARGUMENT");
  });
});
