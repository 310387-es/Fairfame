import type { PublicLocationPage } from "./page.ts";

/**
 * `LocalBusiness` structured data — and **nothing about the reviews**.
 *
 * This file is the P3-T3 amendment in `docs/19` expressed as code, so the
 * reasoning lives where somebody would go to add the missing bit.
 *
 * The task originally asked for `AggregateRating` and `Review` markup. It is
 * not ours to emit. Google's review-snippet policy: *"If the entity that's
 * being reviewed controls the reviews about itself, their pages that use
 * `LocalBusiness` or any other type of `Organization` structured data are
 * ineligible for star review feature"* — and it names our exact case, a review
 * about entity A placed on entity A's own website. A second rule, *"Don't
 * aggregate reviews or ratings from other websites"*, rules out marking up the
 * Google and Instagram reviews we ingest even if the first did not.
 *
 * The Rich Results Test validates **syntax, not policy**, so emitting it anyway
 * would produce a green check, no stars, and a standing risk of a
 * structured-data manual action against a customer's domain. The page still
 * shows its reviews and its average to a human reader; what it does not do is
 * make a machine-readable claim it is not entitled to make.
 *
 * If a future reader wants to add `aggregateRating` here: the number is honest
 * (see `PublicAggregate`) — that was never the problem. The problem is who is
 * saying it and where.
 */

/**
 * Only what we actually know about the place.
 *
 * No invented `priceRange`, no `openingHours` we have never asked for, no
 * `image` we do not have. Structured data is a set of assertions to a search
 * engine, and padding it with plausible-looking fields is how a page ends up
 * asserting something false about a real business.
 */
export type LocalBusinessJsonLd = {
  "@context": "https://schema.org";
  "@type": "LocalBusiness";
  "@id": string;
  name: string;
  url: string;
  /** Free text, because that is how the address was typed. */
  address?: string;
  /** The business's own category, when it set one. */
  additionalType?: string;
  parentOrganization?: { "@type": "Organization"; name: string };
};

export function localBusinessJsonLd(
  page: PublicLocationPage,
  canonicalUrl: string,
): LocalBusinessJsonLd {
  const document: LocalBusinessJsonLd = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    // The page is the thing's identity here, which is all we can honestly
    // claim: we do not hold the business's own website or its Google place id.
    "@id": canonicalUrl,
    // The branch's name, qualified by the business, because "Kadıköy Şubesi"
    // on its own names nothing.
    name:
      page.locationName === page.organizationName
        ? page.organizationName
        : `${page.organizationName} — ${page.locationName}`,
    url: canonicalUrl,
  };

  if (page.address) document.address = page.address;
  if (page.category) document.additionalType = page.category;
  if (page.locationName !== page.organizationName) {
    document.parentOrganization = { "@type": "Organization", name: page.organizationName };
  }

  return document;
}

/**
 * The JSON, safe to put inside a `<script type="application/ld+json">`.
 *
 * `</script>` is the whole reason this is not `JSON.stringify` at the call
 * site. A business name containing that string — or any of `<`, `>`, `&` —
 * would close the element early and turn the rest of the document into markup,
 * which is a stored XSS on an indexable page. The escapes are the standard
 * ones: inside a JSON string literal, `<` means exactly what `<` means, so
 * the data survives intact while the parser never sees a tag.
 *
 * The values here are the business's own (its name, its address), not a
 * stranger's review text — but "the owner typed it" has never been a reason to
 * trust a string, and this page is public.
 */
export function jsonLdScriptBody(document: LocalBusinessJsonLd): string {
  return (
    JSON.stringify(document)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      // U+2028/U+2029 are valid in JSON strings and terminate a line in
      // JavaScript. Harmless in `application/ld+json` today, and one `type`
      // attribute away from not being.
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
  );
}
