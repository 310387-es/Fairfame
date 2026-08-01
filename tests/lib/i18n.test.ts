import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en.json";
import tr from "@/i18n/messages/tr.json";
import { DEFAULT_LOCALE, isLocale, LOCALE_LABELS, LOCALES } from "@/i18n/config";

/**
 * Message catalogues drift silently: someone adds a string in one language and
 * the other renders a raw key in production. These tests make that a failing
 * build instead.
 */

type Messages = Record<string, unknown>;

/** Flattens nested messages into dotted paths. */
function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>();

  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      entries.set(path, value);
    } else if (value && typeof value === "object") {
      for (const [nested, nestedValue] of flatten(value as Messages, path)) {
        entries.set(nested, nestedValue);
      }
    }
  }

  return entries;
}

/**
 * ICU argument names, such as `days` in "{days}" or `count` in
 * "{count, plural, ...}".
 *
 * Only the argument name counts. A plural's sub-messages are themselves brace
 * delimited — "{count, plural, =0 {No reviews} other {# reviews}}" — and those
 * are translated prose, not variables. Requiring an identifier immediately
 * followed by a comma or closing brace excludes them, which matters because
 * the two languages legitimately need different plural categories: Turkish
 * keeps the noun singular after a numeral ("5 yorum"), so it has no separate
 * "=1" form.
 */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((match) => match[1] ?? "").sort();
}

const english = flatten(en as Messages);
const turkish = flatten(tr as Messages);

describe("locale configuration", () => {
  it("ships both launch languages, with Turkish as the default", () => {
    expect([...LOCALES].sort()).toEqual(["en", "tr"]);
    expect(DEFAULT_LOCALE).toBe("tr");
  });

  it("labels every supported locale", () => {
    for (const locale of LOCALES) {
      expect(LOCALE_LABELS[locale]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("rejects unsupported locale codes", () => {
    expect(isLocale("tr")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    // Guards against a raw cookie value being trusted.
    expect(isLocale("tr-TR")).toBe(false);
  });
});

describe("message catalogues", () => {
  it("define exactly the same keys in both languages", () => {
    const missingInTurkish = [...english.keys()].filter((key) => !turkish.has(key));
    const missingInEnglish = [...turkish.keys()].filter((key) => !english.has(key));

    expect(missingInTurkish, "keys present in en but missing from tr").toEqual([]);
    expect(missingInEnglish, "keys present in tr but missing from en").toEqual([]);
  });

  it("contain no empty strings", () => {
    for (const [locale, messages] of [
      ["en", english],
      ["tr", turkish],
    ] as const) {
      for (const [key, value] of messages) {
        expect(value.trim(), `${locale}.${key} is empty`).not.toBe("");
      }
    }
  });

  it("use the same ICU placeholders in both languages", () => {
    // A translation that drops {days} renders a badge with no number in it.
    for (const [key, value] of english) {
      const other = turkish.get(key);
      expect(other).toBeDefined();
      expect(placeholders(other ?? ""), `placeholders differ for "${key}"`).toEqual(
        placeholders(value),
      );
    }
  });

  it("cover every navigation item the shell renders", () => {
    for (const key of ["home", "inbox", "locations", "team", "settings", "signOut"]) {
      expect(english.has(`nav.${key}`), `nav.${key} missing`).toBe(true);
      expect(turkish.has(`nav.${key}`), `nav.${key} missing`).toBe(true);
    }
  });

  it("cover every membership role, since the user menu renders them", () => {
    for (const role of ["owner", "admin", "member", "client"]) {
      expect(english.has(`team.roles.${role}`)).toBe(true);
      expect(turkish.has(`team.roles.${role}`)).toBe(true);
    }
  });

  it("actually translates rather than copying English through", () => {
    // A handful of anchors: if these matched, the tr catalogue would be a stub.
    for (const key of ["nav.home", "nav.inbox", "auth.signIn"]) {
      expect(turkish.get(key)).not.toBe(english.get(key));
    }
  });
});
