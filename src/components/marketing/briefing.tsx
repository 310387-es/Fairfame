import { ChevronDown, Quote } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Stars } from "@/components/ds/stars";
import type { SampleDigest } from "@/digest/sample";
import { getLocale } from "@/i18n/locale";
import { themeLabel } from "@/reviews/taxonomy";

/**
 * The artefact the landing page is built around.
 *
 * Not a screenshot and not a mock: this renders the *real* sample briefing from
 * `getSampleDigest()` — the same metrics, the same prompt and the same
 * arithmetic that will run on a customer's own reviews, over the invented café
 * in `src/digest/sample-data.ts`. That is the direction's entire claim, and a
 * picture of a briefing would forfeit it.
 *
 * **Deliberately not `/sample`'s component, and not the app's.** Three
 * audiences, three pages: `/sample` is a document for somebody who already came
 * looking, `/dashboard` renders a tenant's own rows with actions to complete,
 * and this one is the first thing a stranger sees. The shared thing is the
 * *data*, which is where sharing belongs — `src/digest/sample.ts` is the one
 * definition and all three read it.
 *
 * It borrows the `digest` namespace for the star label and the change
 * sentences, exactly as `/sample` does and for the same reason: two surfaces
 * describing one week must not be able to word it differently.
 */
export async function Briefing({ digest }: { digest: SampleDigest }) {
  const locale = await getLocale();
  const [t, tDigest, tThemes, format] = await Promise.all([
    getTranslations({ locale, namespace: "marketing" }),
    getTranslations({ locale, namespace: "digest" }),
    getTranslations({ locale, namespace: "themes" }),
    getFormatter({ locale }),
  ]);

  /* A canonical key becomes a word in the reader's language; a free tag is
     shown as the customer's own analysis wrote it. */
  const label = (key: string) => themeLabel(key, tThemes);

  /* Locale-formatted, never `toFixed` — Turkish writes a decimal comma, and
     `/sample` shipped a dot on the one surface a prospect sees before they
     trust anything. The same trap sits here. */
  const score = digest.pulse === null ? null : format.number(Math.round(digest.pulse));

  const quotesFor = (theme: string) =>
    digest.themes.find((candidate) => candidate.label === theme)?.quotes ?? [];

  return (
    <article className="rounded-lg border border-line bg-card">
      <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-start sm:gap-8 sm:p-8">
        <div className="min-w-0 flex-1">
          <p className="text-copy text-muted-foreground">
            {digest.business} · {digest.location} · {t("periodLabel", { days: digest.periodDays })}
          </p>

          {/* `display`, not `hero`: the page's own headline above this card is at
              `poster`, and an artefact that shouts as loudly as the page is an
              artefact competing with its own argument. */}
          <h3 className="mt-2 text-display text-balance">{digest.headline}</h3>

          <p className="mt-4 max-w-argument text-body leading-relaxed text-pretty text-ink-600">
            {digest.summary}
          </p>
        </div>

        {/*
          The score, in the same shape and the same ink the dashboard uses.

          Never banded by threshold — indigo means "interactive" and amber means
          "a rating", and a composed 0–100 score is neither (`docs/15` §2). The
          sentence underneath carries the judgement instead.

          Absence is a sentence, not an em-dash. Somebody who has not read
          `MIN_REVIEWS_FOR_PULSE` reads a dash as a rendering failure and
          concludes the gauge is broken — which is exactly what the product's
          own digest tile got wrong until W3.3.
        */}
        <div className="flex shrink-0 flex-col items-center justify-center rounded-lg border border-line px-6 py-5 sm:w-44">
          {score === null ? (
            <p className="text-center text-copy text-balance text-faint">{t("pulseEmpty")}</p>
          ) : (
            <>
              <span className="flex items-baseline gap-1">
                <span className="text-metric-lg tabular-nums">{score}</span>
                <span className="text-copy text-faint">
                  <span aria-hidden>/100</span>
                  <span className="sr-only">{t("outOf")}</span>
                </span>
              </span>
              <span className="mt-2 text-center text-copy font-medium">{t("pulseLabel")}</span>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-line-inner px-6 pb-2 sm:px-8">
        <h4 className="pt-6 pb-1 text-title">{t("actionsTitle")}</h4>
      </div>

      {/*
        The rule stops where the text stops.

        The action rows were on the argument track under separators that ran the
        full card width, leaving ~340px of ruled void to the right of every job.
        A margin is fine; a margin with hairlines drawn across it reads as a
        layout that lost its content. Capping the list — not each paragraph —
        keeps the card wide enough for the score tile above while the rules
        agree with the words underneath them.
      */}
      <ol className="max-w-argument px-6 pb-6 sm:px-8 sm:pb-8">
        {digest.actions.map((action) => {
          const quotes = quotesFor(action.theme);

          return (
            <li
              key={action.position}
              className="flex gap-4 border-t border-line-soft py-4 first:border-t-0"
            >
              <span
                aria-hidden
                /* No `font-mono`: a numeral in a circle is not code, data or a
                   measurement, and monospace as a costume for "technical" is
                   the tell. `tabular-nums` went with it — it does nothing to a
                   single digit. */
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-meta font-semibold text-white"
              >
                {action.position}
              </span>

              <div className="min-w-0 flex-1">
                <p className="max-w-argument text-lead leading-relaxed text-pretty">
                  {action.text}
                </p>

                {/*
                  The page's signature interaction: evidence opens *in place*.

                  A `<details>` rather than state, because this page is a server
                  component rendering links and it must work with scripts off —
                  and because the disclosure is keyboard-operable and announced
                  correctly without a line of ARIA. The product's real screen
                  makes this theme a link to exactly the reviews behind it;
                  here there is no queue to send a stranger to, so the evidence
                  comes to them instead.
                */}
                {quotes.length > 0 ? (
                  <details className="group mt-2">
                    <summary className="tap cursor-pointer list-none gap-1 rounded-sm text-copy font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                      {t("evidenceSummary")}
                      <ChevronDown
                        aria-hidden
                        className="size-3.5 transition-transform group-open:rotate-180"
                      />
                    </summary>

                    <div className="evidence-reveal mt-3">
                      <p className="text-meta text-faint">
                        {t("evidenceIntro", { theme: label(action.theme) })}
                      </p>

                      <ul className="mt-2 flex flex-col gap-3">
                        {quotes.map((quote) => (
                          <li key={quote.text} className="flex gap-2">
                            <Quote
                              aria-hidden
                              className="mt-1 size-3 shrink-0 text-graphic-faint"
                            />
                            <div className="min-w-0">
                              <p className="max-w-evidence text-copy leading-relaxed text-pretty text-ink-600 italic">
                                {quote.text}
                              </p>
                              {quote.rating === null ? null : (
                                <Stars
                                  rating={quote.rating}
                                  size="sm"
                                  className="mt-1"
                                  srLabel={tDigest("starLabel", { rating: quote.rating })}
                                />
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </details>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
