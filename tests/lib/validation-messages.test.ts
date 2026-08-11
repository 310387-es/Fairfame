import { describe, expect, it } from "vitest";
import { z } from "zod";
import en from "@/i18n/messages/en.json";
import tr from "@/i18n/messages/tr.json";
import { VALIDATION_KEYS, msg, type ValidationKey } from "@/lib/validation-keys";
import { toFieldErrors } from "@/server/action-result";

/**
 * A form failure speaks the reader's language.
 *
 * B3 fixed the silence — four forms rejected input and said nothing at all. It
 * did not fix the *language*: the sentence that arrived was Zod's own English
 * default, so a Turkish café owner who left a campaign name blank read "Too
 * small: expected string to have >=1 characters". Better than nothing, and not
 * something to leave.
 *
 * The fix is that a schema now yields a **key** and `useAction` renders it, so
 * this file has two jobs: pin the mapping from a Zod issue to a key, and pin
 * that every key has copy in **both** locales. The second is the one that keeps:
 * `check:i18n` guards keys that appear as `t("literal")` in source, and these
 * are looked up dynamically as `t(key)`, so nothing else in the toolchain would
 * notice a missing Turkish string until it rendered as a raw identifier on
 * somebody's phone.
 */

const messages = { en, tr } as Record<string, { validation: Record<string, string> }>;

/** The one field every case below reports against. */
function keyFor(schema: z.ZodType, value: unknown): string | undefined {
  const parsed = z.object({ field: schema }).safeParse({ field: value });
  if (parsed.success) return undefined;
  return toFieldErrors(parsed.error).field;
}

describe("every validation key has copy in every locale", () => {
  it.each(Object.keys(messages))("%s covers every key", (locale) => {
    const block = messages[locale]?.validation ?? {};

    for (const key of VALIDATION_KEYS) {
      expect(block[key], `${locale}.validation.${key}`).toBeTruthy();
    }

    // The summary is not in the union — it is about the form, not a field — so
    // it would slip past the loop above.
    expect(block.summary, `${locale}.validation.summary`).toBeTruthy();

    /**
     * And the unverified-sender refusal (P5-T4), for the same reason.
     *
     * Also about the action rather than a field: nothing on the form is wrong,
     * the *sender* is not yet allowed to use it. It lives in this namespace
     * because `useAction` is the one place that translates a refusal — the
     * server writes its sentence at the throw, where nobody knows what language
     * the reader is in — and it is asserted here so a locale cannot ship
     * without it and show a café owner the English.
     */
    expect(block.unverifiedEmail, `${locale}.validation.unverifiedEmail`).toBeTruthy();
  });

  it("has no copy for a key that does not exist", () => {
    // The inverse: dead copy is how a namespace grows a key nobody renders and
    // nobody notices is wrong. The two non-field entries are named rather than
    // pattern-matched, so a third one has to be argued for.
    const known = new Set<string>([...VALIDATION_KEYS, "summary", "unverifiedEmail"]);

    for (const locale of Object.keys(messages)) {
      for (const key of Object.keys(messages[locale]?.validation ?? {})) {
        expect(known.has(key), `${locale}.validation.${key} is not a validation key`).toBe(true);
      }
    }
  });

  it("says something different for each one", () => {
    // Two keys with identical copy means one of the distinctions this file
    // draws is not worth drawing, and the reader is being told less than the
    // server knows.
    for (const locale of Object.keys(messages)) {
      const block = messages[locale]?.validation ?? {};
      const values = Object.values(block);
      expect(new Set(values).size, locale).toBe(values.length);
    }
  });
});

describe("a Zod issue becomes a key", () => {
  it("reports a missing value as required", () => {
    expect(keyFor(z.string(), undefined)).toBe("required");
  });

  it("reports an empty string as required, not as too short", () => {
    // `.min(1)` on a required field is how "you must fill this in" is spelled,
    // and Zod calls it `too_small`. The distinction only matters above one.
    expect(keyFor(z.string().trim().min(1, msg("required")), "")).toBe("required");
  });

  it("distinguishes a short string from a small number", () => {
    // Both are `too_small`. "That is too short" about a number reads as a bug.
    expect(keyFor(z.string().min(5), "abc")).toBe("tooShort");
    expect(keyFor(z.number().min(5), 2)).toBe("tooSmall");
  });

  it("distinguishes a long string from a large number", () => {
    expect(keyFor(z.string().max(3), "abcdef")).toBe("tooLong");
    expect(keyFor(z.number().max(3), 9)).toBe("tooLarge");
  });

  it("names the format when it knows it", () => {
    expect(keyFor(z.email(), "not-an-email")).toBe("email");
    expect(keyFor(z.url(), "not-a-url")).toBe("url");
  });

  it("falls back to invalid rather than to a Zod sentence", () => {
    // The important half: whatever Zod adds next, the reader gets product copy.
    // An unmapped code producing raw English is the bug this whole file exists
    // to stop, so the fallback has to be a key too.
    const key = keyFor(
      z.string().refine(() => false, "something no locale has been written for"),
      "x",
    );
    expect(key).toBe("invalid");
    expect(VALIDATION_KEYS).toContain(key as ValidationKey);
  });

  it("carries a hand-written key through untouched", () => {
    expect(keyFor(z.string().regex(/^#[0-9a-f]{6}$/, msg("hexColour")), "blue")).toBe("hexColour");
  });

  it("never returns a key with no copy behind it", () => {
    // The two halves of this file joined up: whatever a schema can produce, both
    // locales can answer.
    const produced = [
      keyFor(z.string(), undefined),
      keyFor(z.string().min(5), "a"),
      keyFor(z.number().max(1), 9),
      keyFor(z.email(), "x"),
      keyFor(z.string().regex(/^a$/, msg("hostname")), "b"),
    ];

    for (const key of produced) {
      expect(key).toBeDefined();
      expect(en.validation[key as keyof typeof en.validation]).toBeTruthy();
      expect(tr.validation[key as keyof typeof tr.validation]).toBeTruthy();
    }
  });
});

describe("what the server sends is a key, not a sentence", () => {
  it("puts no Zod prose in the payload", () => {
    // The regression that matters: someone reverts `toFieldErrors` to
    // `issue.message` and English quietly reaches a Turkish screen again. Every
    // value crossing the wire must be a key we recognise.
    const parsed = z
      .object({ name: z.string().min(1), email: z.email(), count: z.number().max(2) })
      .safeParse({ name: "", email: "nope", count: 9 });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const fields = toFieldErrors(parsed.error);
    expect(Object.keys(fields).sort()).toEqual(["count", "email", "name"]);

    for (const value of Object.values(fields)) {
      expect(VALIDATION_KEYS).toContain(value as ValidationKey);
      expect(value).not.toMatch(/\s/);
    }
  });
});
