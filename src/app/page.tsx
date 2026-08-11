import type { Metadata } from "next";
import { Lora } from "next/font/google";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { Logo } from "@/components/brand/logo";
import { Faq } from "@/components/marketing/faq";
import { FlowTour } from "@/components/marketing/flow-tour";
import { HashLink } from "@/components/marketing/hash-link";
import { MurmurField } from "@/components/marketing/murmur-field";
import { Pillars } from "@/components/marketing/pillars";
import { Pricing } from "@/components/marketing/pricing";
import { Reveal } from "@/components/marketing/reveal";
import { SiteNav } from "@/components/marketing/site-nav";
import { SystemMap } from "@/components/marketing/system-map";
import { getLocale } from "@/i18n/locale";

/**
 * The marketing front door.
 *
 * Until Phase 3 `/` was a router: signed-in to `/dashboard`, everyone else to
 * `/sign-in`. The redirect for a signed-in visitor stays — somebody with an
 * account wants their queue, not the sales page — and the other branch is the
 * page below.
 *
 * This is the brand layer and the only place in the repo that is (`docs/24`
 * §7): warm paper, Lora on the display roles, the murmur behind the hero, the
 * seal at full size. Inside `(app)` none of that exists, and the enforcement
 * is structural rather than editorial — `--font-lora` and `--paper` are both
 * declared on this page's own wrapper, so no surface in the product can reach
 * either one even by accident.
 *
 * ## What this page is not allowed to say
 *
 * `PRODUCT.md` forbids, and none of the copy below contains: customer logos,
 * testimonials, case studies, uplift or ROI figures, user counts, uptime or
 * security claims, and any statement that a platform integration is live. The
 * last one is the easiest to breach by accident — the honest answer is that
 * Google, WhatsApp and Instagram are built against fixtures and a mock, and
 * everything beyond them is roadmap. So the source list is written as a list
 * of *sources*, the FAQ's fifth answer says platforms decide what is possible
 * and every source carries a label, and no chip anywhere says "connected".
 *
 * The one artefact a visitor can check is the sample digest, linked in the
 * footer: `/sample` is composed by the real pipeline, so the thing behind the
 * link is the product rather than a picture of it.
 */

/**
 * The brand's display face, on this page and nowhere else (`docs/24` §4).
 *
 * Declared here rather than in the root layout, which is what keeps the
 * promise "the app shell stays Geist-only" structural instead of a matter of
 * discipline: `--font-lora` is defined on this page's own wrapper, so no
 * surface inside `(app)` can reach it. `globals.css` decides *which* roles use
 * it, and the fallback stack there means a rule that escaped would degrade to
 * Georgia rather than break.
 *
 * `latin-ext` is not optional — ğ, ş and ı live there, and the headline this
 * face was chosen for is read in Turkish first. No `weight`: Lora ships as a
 * variable font, so one file covers the range. `italic` is loaded for the
 * murmur, which draws in nothing else.
 */
const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin", "latin-ext"],
  style: ["normal", "italic"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "marketing" });

  return { title: t("metaTitle"), description: t("metaDescription") };
}

/**
 * The murmur's phrases, in catalogue order.
 *
 * Forty-eight per language, and the number is arithmetic rather than taste:
 * the canvas seeds about one word per 26,000 square pixels, and the front
 * door runs at `density: 2`, so a 1440-wide hero holds roughly ninety of
 * them. `murmur.js` deals from a shuffled deck, so 48 phrases is what keeps
 * ninety words down to no sentence appearing more than twice. Crowding the
 * field further means writing more of these, not reusing these harder — a
 * murmur that repeats itself reads as a bug rather than as a crowd.
 */
const MURMUR_KEYS = [
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "p6",
  "p7",
  "p8",
  "p9",
  "p10",
  "p11",
  "p12",
  "p13",
  "p14",
  "p15",
  "p16",
  "p17",
  "p18",
  "p19",
  "p20",
  "p21",
  "p22",
  "p23",
  "p24",
  "p25",
  "p26",
  "p27",
  "p28",
  "p29",
  "p30",
  "p31",
  "p32",
  "p33",
  "p34",
  "p35",
  "p36",
  "p37",
  "p38",
  "p39",
  "p40",
  "p41",
  "p42",
  "p43",
  "p44",
  "p45",
  "p46",
  "p47",
  "p48",
] as const;

export default async function RootPage() {
  if (await getSession()) redirect("/dashboard");

  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "marketing" });
  // The new-tab hint is shared with the auth panel's link to the same page, so
  // it lives in `app` rather than being written twice in two voices.
  const tApp = await getTranslations({ locale, namespace: "app" });
  const phrases = MURMUR_KEYS.map((key) => t(`murmur.${key}`));

  return (
    <div className={`marketing ${lora.variable} bg-paper text-brand-ink`} id="top">
      {/* `HashLink` like every other same-page anchor here — a plain `<a>`
          leaves a history entry the router cannot restore, and a bare `Link`
          stops scrolling once the reader is already on that hash. The argument
          is in `hash-link.tsx`. */}
      <HashLink
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-100 focus:rounded-lg focus:bg-brand-ink focus:px-4 focus:py-2 focus:text-body focus:text-white"
      >
        {t("skipToContent")}
      </HashLink>

      <SiteNav locale={locale} />

      <main id="main">
        {/*
          The hero fills the first screen and centres in it, and the murmur runs
          the full width behind it.

          `100svh` rather than `100vh`: on a phone `vh` is the viewport with the
          browser chrome *retracted*, so a full-height hero is taller than what
          anybody can actually see and the call to action sits under the address
          bar until they scroll. `svh` is the small viewport — the one that is
          always visible — and `min-h` rather than `h` so a long Turkish
          headline is free to make the section taller instead of overflowing it.

          The 4rem is the masthead, which is sticky and therefore overlaps this
          section rather than displacing it.
        */}
        <MurmurField
          family={lora.style.fontFamily}
          phrases={phrases}
          className="flex min-h-[calc(100svh-4rem)] items-center overflow-hidden"
        >
          <header className="mx-auto w-full max-w-[1200px] px-7 py-20 text-center">
            <div className="mx-auto max-w-[760px]">
              <p className="text-eyebrow text-paper-faint uppercase">{t("hero.eyebrow")}</p>
              <h1 className="mt-4 mb-5 text-poster">
                {t("hero.titleTop")}
                <br />
                {t("hero.titleBottom")}
              </h1>
              <p className="mx-auto mb-7 max-w-[560px] text-marketing text-paper-body">
                {t("hero.sub")}
              </p>

              <div className="flex flex-wrap justify-center gap-3">
                <Link
                  href="/sign-up"
                  className="tap rounded-[10px] border border-brand-ink bg-brand-ink px-5 py-3 text-title text-white"
                >
                  {t("hero.cta1")}
                </Link>
                <HashLink
                  href="#how"
                  className="tap rounded-[10px] border border-paper-line px-5 py-3 text-title hover:border-brand-ink"
                >
                  {t("hero.cta2")}
                </HashLink>
              </div>

              <p className="mx-auto mt-9 max-w-[560px] text-copy text-paper-faint">
                {t("hero.sources")}
              </p>
            </div>
          </header>
        </MurmurField>

        <section id="how" className="mx-auto max-w-[1200px] px-7 py-14">
          <Reveal className="mb-10 max-w-[640px]">
            <p className="text-eyebrow text-paper-faint uppercase">{t("flow.eyebrow")}</p>
            <h2 className="mt-2 mb-3 text-hero">{t("flow.title")}</h2>
            <p className="text-paper-body">{t("flow.sub")}</p>
          </Reveal>
          <FlowTour />
        </section>

        <section id="features" className="mx-auto max-w-[1200px] px-7 py-14">
          <Reveal className="mb-10 max-w-[640px]">
            <p className="text-eyebrow text-paper-faint uppercase">{t("features.eyebrow")}</p>
            <h2 className="mt-2 text-hero">{t("features.title")}</h2>
          </Reveal>

          <Pillars />

          <SystemMap />
        </section>

        <section id="agency" className="mx-auto max-w-[1200px] px-7 py-6">
          <Reveal>
            <div className="flex flex-wrap items-center gap-7 rounded-2xl border border-paper-line bg-white p-8">
              <div className="min-w-[260px] flex-1">
                <p className="text-eyebrow text-paper-faint uppercase">{t("agency.eyebrow")}</p>
                <h2 className="mt-1.5 mb-2 text-display">{t("agency.title")}</h2>
                <p className="max-w-[560px] text-copy text-paper-body">{t("agency.body")}</p>
              </div>
              <HashLink
                href="#cta"
                className="tap rounded-[10px] border border-paper-line px-5 py-3 text-title hover:border-brand-ink"
              >
                {t("agency.cta")}
              </HashLink>
            </div>
          </Reveal>
        </section>

        <section id="pricing" className="mx-auto max-w-[1200px] px-7 py-14">
          <Reveal className="mb-10 max-w-[640px]">
            <p className="text-eyebrow text-paper-faint uppercase">{t("pricing.eyebrow")}</p>
            <h2 className="mt-2 mb-3 text-hero">{t("pricing.title")}</h2>
            <p className="text-paper-body">{t("pricing.sub")}</p>
          </Reveal>

          <Pricing />

          <Reveal>
            <p className="mt-4 max-w-[640px] text-copy text-paper-faint">{t("pricing.note")}</p>
          </Reveal>
        </section>

        {/* The one pull-quote, and the only italic Lora outside the murmur
            (docs/24 §4). It is a citation with a date, not a testimonial —
            PRODUCT.md forbids those, and a 1,100-year-old poem cannot be
            mistaken for a customer. */}
        <Reveal>
          <figure className="mx-auto max-w-[1200px] px-6 py-24 text-center">
            <blockquote className="mx-auto mb-3.5 max-w-[760px] text-hero italic">
              {t("quote.text")}
            </blockquote>
            <figcaption className="text-copy text-paper-faint">{t("quote.source")}</figcaption>
          </figure>
        </Reveal>

        <section id="faq" className="mx-auto max-w-[1200px] px-7 py-14">
          <Reveal className="mb-10">
            <h2 className="text-hero">{t("faq.title")}</h2>
          </Reveal>
          <Faq />
        </section>

        <section id="cta" className="mx-auto max-w-[1200px] px-7 py-14">
          <Reveal>
            <div className="rounded-3xl bg-brand-rail px-8 py-16 text-center">
              <div className="mb-6 flex justify-center">
                <Logo tone="ink" className="h-14" />
              </div>
              <h2 className="mb-2.5 text-hero text-white">{t("cta.title")}</h2>
              <p className="mb-7 text-on-ink-muted">{t("cta.sub")}</p>
              <div className="flex flex-wrap justify-center gap-3">
                <Link
                  href="/sign-up"
                  className="tap rounded-[10px] bg-amber-500 px-5 py-3 text-title text-brand-rail"
                >
                  {t("cta.primary")}
                </Link>
                <HashLink
                  href="#agency"
                  className="tap rounded-[10px] border border-white/25 px-5 py-3 text-title text-white"
                >
                  {t("cta.secondary")}
                </HashLink>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-4 px-7 pt-11 pb-14 text-copy text-paper-faint">
        <Logo className="h-6" />
        <span>{t("footer.note")}</span>
        <div className="ms-auto flex flex-wrap items-center gap-4">
          {/* The sample digest is the page's one checkable claim: it is
              composed by the real pipeline, needs no account, and is the same
              artefact `/sample` serves.

              A new tab, matching the auth panel's link to the same page. It is
              a reference artefact rather than a step in the flow — nothing to
              come back and do on it — and a visitor who opens it to check the
              claim should not lose their place in the pitch that made it. */}
          <Link
            href="/sample"
            target="_blank"
            rel="noopener"
            className="tap underline underline-offset-4 hover:text-brand-ink"
          >
            {t("footer.sample")}
            <span className="sr-only"> ({tApp("opensInNewTab")})</span>
          </Link>
          <Link href="/sign-in" className="tap hover:text-brand-ink">
            {t("footer.signIn")}
          </Link>
        </div>
      </footer>
    </div>
  );
}
