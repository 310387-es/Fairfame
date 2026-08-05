import { describe, expect, it } from "vitest";
import { preferredSlug, slugify, uniqueSlug } from "@/seo/slug";

/**
 * The address of a hosted review page (P3-T3).
 *
 * This is a small pure function guarding a decision that cannot be taken back:
 * the slug is minted once and then indexed, so a bug here is not a bad URL for
 * a minute — it is a bad URL forever, or a URL that changes and loses whatever
 * it had earned.
 *
 * The Turkish cases are the reason the file exists. The launch market's letters
 * do not survive the usual `normalize("NFD")` recipe, and the failure is quiet:
 * `ı` and `İ` come out as an empty string or as a locale-dependent one, so the
 * same café gets a different address depending on where the server runs.
 */

describe("what a name turns into", () => {
  it("transliterates the Turkish letters rather than dropping them", () => {
    // `ı` is not `i` with a mark, and `ğ` decomposes in a way that would lose
    // the letter entirely. Both are mapped by hand.
    expect(slugify("Kadıköy Kahve")).toBe("kadikoy-kahve");
    expect(slugify("Çiğdem Güneş")).toBe("cigdem-gunes");
    expect(slugify("Şişli Şubesi")).toBe("sisli-subesi");
  });

  it("handles the dotted capital İ the same way in every locale", () => {
    // `"İ".toLowerCase()` is "i" in a Turkish locale and "i̇" (i + combining
    // dot) everywhere else. Mapped ahead of the lowercase pass, so the answer
    // does not depend on where the server thinks it is.
    expect(slugify("İstanbul")).toBe("istanbul");
    expect(slugify("İZMİR")).toBe("izmir");
  });

  it("still handles the accented Latin everyone else writes", () => {
    expect(slugify("Café Crème")).toBe("cafe-creme");
    expect(slugify("Piñata Ñoño")).toBe("pinata-nono");
  });

  it("turns punctuation into boundaries rather than into characters", () => {
    expect(slugify("St. Mary's Café & Co.")).toBe("st-mary-s-cafe-co");
    expect(slugify("  spaced   out  ")).toBe("spaced-out");
    expect(slugify("---edges---")).toBe("edges");
  });

  it("returns nothing when there is nothing left, instead of a row of hyphens", () => {
    // A real case: a name in a script this does not transliterate. The caller
    // needs to be able to tell, which a string of separators would hide.
    expect(slugify("日本語")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("never emits a character that would need escaping in a URL", () => {
    const messy = "Ürün / Şube #3 — 100% «iyi» (yeni)";
    const slug = slugify(messy);

    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(encodeURIComponent(slug)).toBe(slug);
  });

  it("bounds the length, without leaving a trailing hyphen behind", () => {
    const slug = slugify("a".repeat(50) + " " + "b".repeat(50));

    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("the slug a location asks for", () => {
  it("uses both names, because a branch name alone names nothing", () => {
    expect(preferredSlug("Kadıköy Kahve", "Şişli Şubesi")).toBe("kadikoy-kahve-sisli-subesi");
  });

  it("does not repeat itself when a business is its own only branch", () => {
    expect(preferredSlug("Kadıköy Kahve", "Kadıköy Kahve")).toBe("kadikoy-kahve");
  });

  it("falls back to whichever name survives", () => {
    expect(preferredSlug("日本語", "Kadıköy")).toBe("kadikoy");
    expect(preferredSlug("Kadıköy Kahve", "日本語")).toBe("kadikoy-kahve");
  });
});

describe("uniqueness", () => {
  const takenSet = (taken: string[]) => async (candidate: string) => taken.includes(candidate);

  it("takes the readable slug when it is free", async () => {
    expect(await uniqueSlug("kadikoy-kahve", takenSet([]), () => "xxxx")).toBe("kadikoy-kahve");
  });

  it("numbers a collision rather than randomising it", async () => {
    // `-2` reads as "the second one of these", which is what it is. Two of a
    // business's own URLs stay tellable apart.
    const slug = await uniqueSlug("kadikoy-kahve", takenSet(["kadikoy-kahve"]), () => "xxxx");
    expect(slug).toBe("kadikoy-kahve-2");
  });

  it("keeps counting past the first collision", async () => {
    const slug = await uniqueSlug(
      "kadikoy-kahve",
      takenSet(["kadikoy-kahve", "kadikoy-kahve-2", "kadikoy-kahve-3"]),
      () => "xxxx",
    );
    expect(slug).toBe("kadikoy-kahve-4");
  });

  it("gives an unslugifiable name an address anyway", async () => {
    // No readable slug is available, and a page with no address is worse than
    // one with an unlovely address.
    expect(await uniqueSlug("", takenSet([]), () => "abc12345")).toBe("abc12345");
  });

  it("gives up on numbering rather than looping against a unique index", async () => {
    // Every numbered candidate taken. It must still return something, and that
    // something must be unique by construction rather than by another query.
    const slug = await uniqueSlug(
      "cafe",
      async () => true,
      () => "abc12345",
    );
    expect(slug).toBe("cafe-abc12345");
  });
});
