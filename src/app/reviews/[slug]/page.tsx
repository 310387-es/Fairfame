import { sourceShortLabel } from "@/connectors/source-label";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PublicMark } from "@/components/brand/public-mark";
import { resolveBrand } from "@/agency/branding";
import { Stars } from "@/components/ds/stars";
import type { Locale } from "@/i18n/config";
import { publicBaseUrl } from "@/lib/urls";
import { jsonLdScriptBody, localBusinessJsonLd } from "@/seo/jsonld";
import { loadLocationPageContent, resolveLocationPageBySlug } from "@/seo/page";
import { locationPageUrl } from "@/seo/urls";

/**
 * The hosted review page: `/reviews/{slug}` (P3-T3).
 *
 * Public, unauthenticated, and the first surface in the product that *wants* to
 * be indexed. Everything else public is deliberately not: the collection page
 * is a private link handed to one customer, and the embed document is a
 * fragment that would compete with this page if it were crawlable.
 *
 * Three properties it has to keep, in order of how expensive they are to get
 * wrong:
 *
 *   1. **Only this location's approved reviews.** The tenant comes from the
 *      slug, the read runs under RLS, and the clauses are the ones in
 *      `src/widgets/scope.ts` that the builder's approval list also uses. A
 *      leak here is crawled and cached, not merely seen.
 *   2. **`LocalBusiness` markup and nothing about the reviews.** See
 *      `src/seo/jsonld.ts` for the policy this follows and why the obvious
 *      addition is the wrong one.
 *   3. **The location's language, not the visitor's.** Same rule as the widget
 *      and the collection page — a Turkish café's page reads Turkish to
 *      everyone, and a crawler is told so in `lang`.
 *
 * Server-rendered with no client component in it at all: this page's job is to
 * be fast and legible to a crawler, and there is nothing on it to interact with.
 */

type PageProps = { params: Promise<{ slug: string }> };

/**
 * Cached at the edge for five minutes, like the widget endpoints.
 *
 * A review approved now should appear soon, not instantly — and the alternative
 * is rendering a database read for every crawler hit on every customer's page.
 */
export const revalidate = 300;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await resolveLocationPageBySlug(slug);

  // Unknown and unpublished get the same answer here as in the body: no title,
  // no description, and `notFound()` below. Nothing distinguishes "there is no
  // such page" from "there is one and it is not live", which is what keeps this
  // route from being a way to enumerate businesses.
  if (!page?.published) return { title: "Revira" };

  const t = await getTranslations({ locale: page.locale, namespace: "publicPage" });
  const canonical = locationPageUrl(publicBaseUrl(), page.slug);

  return {
    title: t("metaTitle", { business: page.organizationName, location: page.locationName }),
    description: t("metaDescription", { business: page.organizationName }),
    // The point of the whole task. Stated rather than left to the default,
    // because every other public route in this product says the opposite and a
    // reader should not have to infer which one this is.
    robots: { index: true, follow: true },
    alternates: { canonical },
    openGraph: {
      type: "website",
      url: canonical,
      title: t("metaTitle", { business: page.organizationName, location: page.locationName }),
      description: t("metaDescription", { business: page.organizationName }),
      locale: page.locale,
    },
  };
}

function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(iso));
}

/** Locale-formatted, so Turkish gets its decimal comma (`docs/15` §Content). */
function formatScore(average: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(average);
}

export default async function LocationReviewsPage({ params }: PageProps) {
  const { slug } = await params;
  const page = await resolveLocationPageBySlug(slug);

  if (!page?.published) notFound();

  const [t, content, brand] = await Promise.all([
    getTranslations({ locale: page.locale, namespace: "publicPage" }),
    loadLocationPageContent(page),
    // Whose page this is (P4-T5). An agency's client shows the agency's mark.
    resolveBrand(page.organizationId),
  ]);

  const { reviews, aggregate } = content;
  const canonical = locationPageUrl(publicBaseUrl(), page.slug);
  const structuredData = jsonLdScriptBody(localBusinessJsonLd(page, canonical));

  return (
    // `lang` on the content, not on `<html>`.
    //
    // The root layout is one document for the whole app and renders in the
    // *visitor's* locale; this subtree is in the location's, which is a
    // property of the data. Marking the change here is exactly what the HTML
    // spec is for and is what makes a screen reader switch pronunciation
    // mid-page instead of reading Turkish with English phonetics.
    //
    // The `<html lang>` above it still says the visitor's language, and that is
    // a known cosmetic mismatch rather than an SEO problem: Google determines a
    // page's language from its visible content and says it ignores `lang`
    // attributes for that purpose. Fixing it properly would mean a second root
    // layout, which Next allows only one of per route tree.
    <main lang={page.locale} className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
      {/* Not `dangerouslySetInnerHTML` on a template string built by hand: the
          body comes from `jsonLdScriptBody`, which escapes the four characters
          that could close this element early. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />

      <header className="border-b border-line-soft pb-6">
        {/* `text-hero`, which `globals.css` marks "public surfaces only" — this
            is a page a stranger lands on, not a card inside the app. */}
        <h1 className="text-hero text-balance text-foreground">
          {page.locationName === page.organizationName
            ? page.organizationName
            : `${page.organizationName} · ${page.locationName}`}
        </h1>

        {page.address ? <p className="mt-1 text-body text-ink-400">{page.address}</p> : null}

        {aggregate.average === null || aggregate.count === 0 ? (
          // A state, not a zero — `docs/15` §Content.
          <p className="mt-4 text-body text-ink-400">{t("noRatings")}</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-metric font-semibold text-foreground tabular-nums">
              {formatScore(aggregate.average, page.locale)}
            </span>
            <Stars
              rating={aggregate.average}
              srLabel={t("starLabel", { rating: Math.round(aggregate.average) })}
            />
            <span className="text-body text-ink-400">
              {t("ratingCount", { count: aggregate.count })}
            </span>
          </div>
        )}

        {/* The sentence the markup is not allowed to make. It says where the
            number comes from, which is the honest version of an
            `AggregateRating` claim — and it is true in a way a curated average
            would not be. See `PublicAggregate`. */}
        <p className="mt-2 text-meta text-faint">{t("aggregateBasis")}</p>
      </header>

      {reviews.length === 0 ? (
        <p className="py-14 text-center text-body text-ink-400">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {reviews.map((review) => (
            <li key={review.id} className="py-6">
              <article>
                {review.rating !== null ? (
                  <Stars
                    rating={review.rating}
                    srLabel={t("starLabel", { rating: review.rating })}
                  />
                ) : null}

                {review.text ? (
                  <p className="mt-2 text-copy [overflow-wrap:anywhere] text-foreground">
                    {review.text}
                  </p>
                ) : null}

                <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-meta text-faint">
                  {review.authorName ? (
                    <span className="font-semibold text-ink-400">{review.authorName}</span>
                  ) : null}
                  <span>{sourceShortLabel(review.source)}</span>
                  {review.postedAt ? <span>{formatDate(review.postedAt, page.locale)}</span> : null}
                  {review.url ? (
                    // `nofollow ugc`: third-party links a business placed on a
                    // page about itself is exactly what the attribute is for.
                    <a
                      href={review.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {t("viewOriginal")}
                    </a>
                  ) : null}
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-10 flex items-center justify-between gap-4 border-t border-line-soft pt-6">
        <PublicMark brand={brand} />
        {/*
          The credit line goes with the mark. An agency that has bought the
          right to remove ours has bought the sentence too — leaving "Powered by
          Revira" under somebody else's logo would be the worst of both.
        */}
        {brand.whiteLabelled || !brand.showPoweredBy ? null : (
          <p className="text-meta text-faint">{t("poweredBy")}</p>
        )}
      </footer>
    </main>
  );
}
