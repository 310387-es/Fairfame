import { describe, expect, it } from "vitest";
import { jsonLdScriptBody, localBusinessJsonLd } from "@/seo/jsonld";
import type { PublicLocationPage } from "@/seo/page";

/**
 * The structured data on a hosted review page (P3-T3).
 *
 * Two jobs. The first is a **policy** assertion, which is unusual for a test
 * and is the whole point of this one: `docs/19` was amended to carry
 * `LocalBusiness` and *no review markup*, because a business's own reviews on
 * its own site are ineligible for Google's star feature and aggregating other
 * sites' ratings is separately forbidden. Nothing in a type or a linter stops
 * somebody adding `aggregateRating` — a Rich Results Test would even go green.
 * This is what stops it.
 *
 * The second is escaping. This document goes inside a `<script>` element on an
 * indexable page, and a business name containing `</script>` would end the
 * element and turn the rest of the page into markup.
 */

const page = (overrides: Partial<PublicLocationPage> = {}): PublicLocationPage => ({
  organizationId: "o1",
  organizationName: "Kadıköy Kahve",
  locationId: "l1",
  locationName: "Şişli Şubesi",
  address: "Halaskargazi Cd. 1, Şişli",
  category: "Cafe",
  slug: "kadikoy-kahve-sisli-subesi",
  published: true,
  locale: "tr",
  ...overrides,
});

const URL_ = "https://revira.example/reviews/kadikoy-kahve-sisli-subesi";

describe("what the page claims about the business", () => {
  it("is a LocalBusiness at the page's own address", () => {
    const document = localBusinessJsonLd(page(), URL_);

    expect(document["@type"]).toBe("LocalBusiness");
    expect(document["@id"]).toBe(URL_);
    expect(document.url).toBe(URL_);
  });

  it("names the branch through the business, since a branch name names nothing", () => {
    expect(localBusinessJsonLd(page(), URL_).name).toBe("Kadıköy Kahve — Şişli Şubesi");
  });

  it("does not repeat itself when the branch is the business", () => {
    const document = localBusinessJsonLd(
      page({ locationName: "Kadıköy Kahve", organizationName: "Kadıköy Kahve" }),
      URL_,
    );

    expect(document.name).toBe("Kadıköy Kahve");
    // And no parent organization, because there is no parent to name.
    expect(document.parentOrganization).toBeUndefined();
  });

  it("omits what it does not know rather than inventing it", () => {
    // Structured data is a set of assertions. A `priceRange` we never asked for
    // would be a false one about a real business.
    const document = localBusinessJsonLd(page({ address: null, category: null }), URL_);

    expect(document.address).toBeUndefined();
    expect(document.additionalType).toBeUndefined();
    expect(Object.keys(document).sort()).toEqual([
      "@context",
      "@id",
      "@type",
      "name",
      "parentOrganization",
      "url",
    ]);
  });
});

describe("what it must never claim", () => {
  it("carries no rating, no review and no aggregate — the P3-T3 amendment", () => {
    // The assertion the whole file exists for. If a future change adds any of
    // these, this fails and the comment in src/seo/jsonld.ts explains why.
    //
    // Checked against the *keys and types*, not against the serialized text:
    // the canonical URL contains the word "reviews" — it is a page of them —
    // and a substring search would either fail on that or be softened until it
    // stopped catching anything.
    const document = localBusinessJsonLd(page(), URL_);

    const keys = (node: unknown): string[] =>
      node !== null && typeof node === "object"
        ? Object.entries(node).flatMap(([key, value]) => [key, ...keys(value)])
        : [];

    for (const key of keys(document)) {
      expect(key).not.toMatch(/rating|review/i);
    }

    const types = (node: unknown): unknown[] =>
      node !== null && typeof node === "object"
        ? Object.entries(node).flatMap(([key, value]) =>
            key === "@type" ? [value, ...types(value)] : types(value),
          )
        : [];

    expect(types(document)).toEqual(["LocalBusiness", "Organization"]);
  });
});

describe("putting it inside a script element", () => {
  it("cannot close the element it sits in", () => {
    const hostile = page({ organizationName: `Kahve</script><img src=x onerror=alert(1)>` });
    const body = jsonLdScriptBody(localBusinessJsonLd(hostile, URL_));

    expect(body).not.toContain("</script>");
    expect(body).not.toContain("<img");
    // The name survives as data — escaped, not destroyed. `<` is `<` to
    // any JSON parser, so a consumer reads exactly what was typed.
    expect(JSON.parse(body).name).toContain("</script>");
  });

  it("escapes the line terminators that are legal in JSON and not in JavaScript", () => {
    const body = jsonLdScriptBody(localBusinessJsonLd(page({ address: "a b" }), URL_));

    expect(body).not.toContain(" ");
    expect(JSON.parse(body).address).toBe("a b");
  });

  it("stays valid JSON after all of it", () => {
    const body = jsonLdScriptBody(localBusinessJsonLd(page(), URL_));
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body)["@context"]).toBe("https://schema.org");
  });
});
