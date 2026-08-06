import { describe, expect, it } from "vitest";
import { parseAcceptLanguage, resolveLocale } from "@/i18n/resolve";

/**
 * Which language somebody gets (W3.3, folded in from P1-11).
 *
 * The order is **user → organization → browser → tr**, and every step of it
 * used to be the last one: the cookie was the only input, so a Turkish
 * business whose owner works in English got Turkish on every new device, and
 * an account created through an English browser got Turkish because that is
 * what the constant says.
 */

describe("the precedence", () => {
  it("prefers the person over the business", () => {
    // A Turkish company with an English-speaking manager. The manager's own
    // choice is the one they made deliberately.
    expect(resolveLocale({ user: "en", organization: "tr", header: "tr-TR" })).toBe("en");
  });

  it("falls to the organization when the person has no preference", () => {
    expect(resolveLocale({ user: null, organization: "en", header: "tr-TR" })).toBe("en");
  });

  it("falls to the browser when neither has one", () => {
    expect(resolveLocale({ user: null, organization: null, header: "en-GB,en;q=0.9" })).toBe("en");
  });

  it("falls to Turkish last, because that is the launch market", () => {
    expect(resolveLocale({})).toBe("tr");
    expect(resolveLocale({ user: null, organization: null, header: "de-DE,fr;q=0.8" })).toBe("tr");
  });

  it("ignores a stored value that is not a locale we speak", () => {
    // A column is free text; a row written by an import, an older version or a
    // hand-edited fixture must not take the app somewhere it cannot render.
    expect(resolveLocale({ user: "de", organization: "en" })).toBe("en");
    expect(resolveLocale({ user: "", organization: "" })).toBe("tr");
  });
});

describe("Accept-Language", () => {
  it("reads a region tag as its language", () => {
    // `tr-TR` and `tr` are the same answer, and the header is written by a
    // browser rather than by the person.
    expect(parseAcceptLanguage("tr-TR")).toBe("tr");
    expect(parseAcceptLanguage("en-US,en;q=0.9")).toBe("en");
  });

  it("takes the first language it can serve, not the first listed", () => {
    // A German-first browser that also accepts English gets English rather
    // than the default, which is the whole point of consulting the header.
    expect(parseAcceptLanguage("de-DE,de;q=0.9,en;q=0.8")).toBe("en");
  });

  it("says nothing rather than guessing", () => {
    expect(parseAcceptLanguage("de-DE,fr;q=0.8")).toBeNull();
    expect(parseAcceptLanguage("")).toBeNull();
    expect(parseAcceptLanguage(null)).toBeNull();
    expect(parseAcceptLanguage("*")).toBeNull();
  });

  it("survives a malformed header instead of throwing", () => {
    // It is an untrusted request header; a parser that threw would take the
    // sign-in page down for anybody with an unusual browser.
    expect(parseAcceptLanguage(",,;q=,")).toBeNull();
    expect(parseAcceptLanguage("en;;;")).toBe("en");
  });
});
