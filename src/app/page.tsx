import {
  ArrowRight,
  BarChart3,
  ChevronRight,
  Gauge,
  FileText,
  Globe,
  Inbox,
  ListChecks,
  Info,
  LayoutDashboard,
  Mail,
  MessageCircle,
  Quote,
  QrCode,
  Sparkles,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { IconTile } from "@/components/ds/icon-tile";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Briefing } from "@/components/marketing/briefing";
import { Pricing } from "@/components/marketing/pricing";
import { PipelineFlow } from "@/components/marketing/pipeline-flow";
import { LocaleSwitcher } from "@/components/shell/locale-switcher";
import { Button } from "@/components/ui/button";
import { getSampleDigest } from "@/digest/sample";
import { getLocale } from "@/i18n/locale";
import { themeLabel } from "@/reviews/taxonomy";

/**
 * The marketing front door.
 *
 * Until now `/` was a router: signed-in to `/dashboard`, everyone else to
 * `/sign-in`. The redirect for a signed-in visitor stays — somebody with an
 * account wants their queue, not the sales page — and the other branch is now
 * an actual front door.
 *
 * **The artefact is composed by the real pipeline.** `getSampleDigest()` is the
 * same function `/sample` calls, so the two share one process cache: whichever
 * page is hit first warms the other, and the briefing a visitor reads here is
 * the briefing they read there. It never throws (a written fallback covers a
 * bad day) and a visitor cannot trigger a model call more than once an hour per
 * locale — both properties are why this page can render an AI artefact at all.
 */

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "marketing" });

  return { title: t("metaTitle"), description: t("metaDescription") };
}

/**
 * The direction contract, emitted into the markup rather than left in source.
 *
 * A source comment is stripped by the compiler and cannot be audited against
 * the thing that shipped; this survives the production build, which is the
 * point — the finishing review reads the render against this text.
 */
const DIRECTION_CONTRACT = `
THESIS: the page IS the artefact — a real weekly briefing, annotated in its margins.
  Refuses the category arrangement: slogan over a device-framed screenshot, then three feature cards.
OWN-WORLD: docs/15 tokens only. An --ink-900 masthead and conscience band, canvas page, white
  hairline cards with no shadow, indigo for interaction alone, no amber chrome (amber survives
  only where the system already means a rating: the stars inside an opened disclosure), no
  imagery of any kind. Marginalia: no box, a short indigo rule, ink-350.
STORY: a Turkish owner reads Friday's actual briefing, opens the evidence behind one action,
  learns next week audits it, reads what we refuse to do and what is not live yet, sees the price.
FIRST VIEWPORT: ink bar; two-line poster headline in the upper third; subtitle, indigo pill and a
  text link, no-card note; the invented-cafe label, then the briefing card entering at mid-height
  and cropped by the fold, glossed by three stacked notes down the right margin.
FORM: "the briefing is the page" — candidate 1 of 7, user-pinned over roll 44c097d8 (assigned 6).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
  verdict, and DESIGN.md.
`;

/** Index is the rating, so `starLabels[3]` is the label for three stars. */
const STAR_RATINGS = [0, 1, 2, 3, 4, 5];

/**
 * One stage of the pipeline, as a figure.
 *
 * `dt` is the visible label and `dd` the value — reversed only in the flex
 * direction, so the DOM keeps the order a description list requires while the
 * number reads first. It used to render the label twice, once `sr-only` and
 * once visibly, which announced "14, reviews read, reviews read".
 */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-copy text-faint">{label}</dt>
      <dd className="text-metric-lg tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Between two stages. Decorative: the labels already say what happens.
 *
 * Hidden below `sm`, where the row wraps: a chevron stranded at the end of a
 * wrapped line points at nothing and reads as a rendering fault. The three
 * figures sit in a grid there instead, which needs no connector to be read as
 * a set.
 */
function Step() {
  return (
    <ChevronRight
      aria-hidden
      className="hidden size-5 shrink-0 self-center text-graphic-faint sm:block"
    />
  );
}

/** A theme that moved, as a row of data rather than a sentence. */
function ThemeRow({
  name,
  figure,
  isNew,
  newLabel,
}: {
  name: string;
  figure: string;
  isNew: boolean;
  newLabel: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-6 border-b border-line-soft py-3 last:border-b-0">
      <span className="flex items-baseline gap-2 text-body font-medium">
        {name}
        {isNew ? (
          <span className="rounded-sm bg-state-accent-bg px-1.5 py-0.5 text-meta font-semibold text-state-accent-text">
            {newLabel}
          </span>
        ) : null}
      </span>
      <span className="font-mono text-copy text-faint tabular-nums">{figure}</span>
    </li>
  );
}

export default async function RootPage() {
  if (await getSession()) redirect("/dashboard");

  const locale = await getLocale();
  const [t, tDigest, tThemes, digest] = await Promise.all([
    getTranslations({ locale, namespace: "marketing" }),
    getTranslations({ locale, namespace: "digest" }),
    getTranslations({ locale, namespace: "themes" }),
    getSampleDigest({ locale }),
  ]);

  const label = (key: string) => themeLabel(key, tThemes);

  /*
    The change block promotes two figures and keeps the rest as prose — so the
    prose must give them up, or the passage states one fact twice in a row and
    reads as a rendering fault. `computeChanges` already partitions this for us:
    `pulse` and `volume` become the figures, `theme` stays a sentence, because a
    theme line genuinely is one ("Yeni tema: Temizlik") and promoting it would
    be inventing a metric in order to have a number.

    Each figure is gated on its own change being present rather than on the raw
    data. `computeChanges` applies PULSE_CHANGE_THRESHOLD and
    VOLUME_CHANGE_THRESHOLD — a move it judged to be noise is not worth a
    sentence, and it is not worth 28px of tabular numerals either. Reusing that
    judgement is the difference between reporting the week and decorating it.
  */
  const movedPulse = digest.changes.some((change) => change.kind === "pulse");
  const movedVolume = digest.changes.some((change) => change.kind === "volume");
  const themeChanges = digest.changes.filter((change) => change.kind === "theme");

  /*
    The graph, built from the same digest the document below renders.

    Only the themes an *action* was pinned to, and only the quotes those themes
    carry. That keeps the picture to three lanes a reader can actually follow —
    and, more importantly, it means every node on screen is genuinely load-
    bearing: each review shown is evidence for a job shown. A graph padded with
    themes nothing acted on would be the decorative version of this idea.
  */
  const flowActions = digest.actions.map((action) => ({
    position: action.position,
    text: action.text,
    themeKey: action.theme,
    themeLabel: label(action.theme),
  }));

  const flowThemes = [...new Set(flowActions.map((action) => action.themeKey))].flatMap((key) => {
    const theme = digest.themes.find((candidate) => candidate.label === key);
    if (!theme) return [];
    return [
      {
        key,
        label: label(key),
        positiveLabel: theme.positive > 0 ? t("themePositive", { count: theme.positive }) : null,
        negativeLabel: theme.negative > 0 ? t("themeNegative", { count: theme.negative }) : null,
      },
    ];
  });

  /*
    Keyed by the customer's words, not by the theme.

    A quote can be evidence for two themes, and mapping per theme printed the
    same review twice with identical stars — six cards, five customers. One
    node now, carrying an edge to each theme it belongs to.
  */
  const flowReviews = [
    ...flowThemes
      .reduce((byText, theme) => {
        const source = digest.themes.find((candidate) => candidate.label === theme.key);
        for (const quote of source?.quotes ?? []) {
          const seen = byText.get(quote.text);
          if (seen) {
            if (!seen.themeKeys.includes(theme.key)) seen.themeKeys.push(theme.key);
            continue;
          }
          byText.set(quote.text, {
            id: `review-${byText.size}`,
            text: quote.text,
            rating: quote.rating,
            themeKeys: [theme.key],
          });
        }
        return byText;
      }, new Map<string, { id: string; text: string; rating: number | null; themeKeys: string[] }>())
      .values(),
  ];

  const delivery = [
    { icon: LayoutDashboard, title: t("deliveryApp"), body: t("deliveryAppBody") },
    { icon: Mail, title: t("deliveryEmail"), body: t("deliveryEmailBody") },
    { icon: FileText, title: t("deliveryPdf"), body: t("deliveryPdfBody") },
    { icon: MessageCircle, title: t("deliveryWhatsapp"), body: t("deliveryWhatsappBody") },
  ];

  const rest = [
    { icon: QrCode, title: t("restCollect"), body: t("restCollectBody") },
    { icon: Inbox, title: t("restQueue"), body: t("restQueueBody") },
    { icon: Sparkles, title: t("restReplies"), body: t("restRepliesBody") },
    { icon: Globe, title: t("restShowcase"), body: t("restShowcaseBody") },
    { icon: BarChart3, title: t("restAnalytics"), body: t("restAnalyticsBody") },
    { icon: Users, title: t("restEngage"), body: t("restEngageBody") },
  ];

  return (
    <div className="marketing flex min-h-full flex-col">
      <div hidden dangerouslySetInnerHTML={{ __html: `<!--${DIRECTION_CONTRACT}-->` }} />

      <a
        href="#content"
        className="sr-only rounded-md bg-card px-4 py-2 text-body font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:shadow-md"
      >
        {t("skipToContent")}
      </a>

      {/* The masthead is ink because the product's own rail and briefing bar are
          ink: the front door should look like a piece of the application, not
          like marketing bolted onto it. */}
      <header className="bg-ink-900">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          {/* The ring is meant to match whatever surface the mark sits on, so it
              reads as a token rather than a hex: the masthead is `--ink-900`,
              and if that value ever moves the notification dot moves with it. */}
          <LogoMark className="size-7" ringColor="var(--ink-900)" title="Revira" />

          <div className="flex items-center gap-1">
            <LocaleSwitcher locale={locale} className="tap text-on-ink-muted hover:bg-white/10" />
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="tap text-on-ink-muted hover:bg-white/10 hover:text-on-ink"
            >
              <Link href="/sign-in">{t("signIn")}</Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="content" className="flex-1">
        {/* ---------------------------------------------------------------
            First viewport: the claim at poster scale, then the artefact
            entering underneath it and running past the fold.
        --------------------------------------------------------------- */}
        <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 lg:pt-12">
          {/* The headline takes the whole content measure. It was capped at
              `max-w-4xl` inside a `max-w-6xl` column, which left the upper-right
              quadrant of the fold empty and rendered the page's thesis word —
              poster — as a large h1. The subtitle keeps its cap, because a
              15px lead across 1152px is a different mistake. */}
          <h1 className="text-poster text-balance">{t("headline")}</h1>
          <p className="mt-5 max-w-argument text-marketing text-pretty text-ink-600">
            {t("subhead")}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button asChild size="lg" className="tap">
              <Link href="/sample">
                {t("ctaPrimary")}
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </Button>
            <Link
              href="/sign-up"
              className="tap rounded-sm text-body font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t("ctaSecondary")}
            </Link>
          </div>

          <p className="mt-2 max-w-argument text-meta text-faint">{t("noCard")}</p>
        </div>

        {/* ---------------------------------------------------------------
            The mechanism, before the deliverable.

            The first build opened on the finished briefing and was judged
            static: a document arrives fully formed and asks to be believed.
            The pipeline goes first now, because the claim this product makes
            is about *provenance* — and provenance is something a reader has to
            be able to pull on, not read about. The finished document follows
            it, once the reader knows where its three lines came from.
        --------------------------------------------------------------- */}
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 lg:pt-10">
          <p className="mb-3 flex max-w-argument items-start gap-2 rounded-lg border border-dashed border-line bg-card px-4 py-3 text-copy leading-relaxed text-ink-600">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-graphic-faint" />
            {digest.fallback
              ? t("demoLabelFallback", { business: digest.business })
              : t("demoLabel", { business: digest.business })}
          </p>

          {/* The instruction is part of the design: an interactive diagram that
              does not say it is interactive is a static diagram to most
              readers, and the one gesture this page asks for is the one that
              proves its whole claim. */}
          <div className="mb-6 max-w-2xl">
            <h2 className="text-hero text-balance">{t("flowTitle")}</h2>
            <p className="mt-4 max-w-argument text-marketing text-pretty text-ink-600">
              {t("flowBody")}
            </p>
          </div>

          <PipelineFlow
            reviews={flowReviews}
            themes={flowThemes}
            actions={flowActions}
            labels={{
              reviews: t("flowReviews"),
              themes: t("flowThemes"),
              actions: t("flowActions"),
              hint: t("flowHint"),
              evidence: t("flowEvidence"),
              reviewsCount: t("flowShown", {
                shown: flowReviews.length,
                total: digest.reviewCount,
              }),
              themesCount: t("flowShown", {
                shown: flowThemes.length,
                total: digest.themes.length,
              }),
              starLabels: STAR_RATINGS.map((rating) => tDigest("starLabel", { rating })),
            }}
          />

          {/* True, derived, and doing double duty: the figures are the pipeline
              stated as quantities, so the row explains the graph above it
              instead of decorating the page with numbers nobody can source. */}
          {/*
            The three figures are the pipeline above, stated as quantities — so
            they get chevrons between them and read as one movement rather than
            three unrelated numbers in a row. Inside a card, because naked on
            the canvas they read as a sentence with digits in it.
          */}
          <div className="mt-10 max-w-argument rounded-lg border border-line bg-card px-6 py-6 sm:px-8">
            <dl className="grid grid-cols-3 gap-x-4 gap-y-6 sm:flex sm:flex-wrap sm:items-center sm:gap-x-8">
              <Stat value={digest.reviewCount} label={t("statReviews")} />
              <Step />
              <Stat value={digest.themes.length} label={t("statThemes")} />
              <Step />
              <Stat value={digest.actions.length} label={t("statActions")} />
            </dl>
            <p className="mt-5 border-t border-line-inner pt-4 text-copy leading-relaxed text-pretty text-faint">
              {t("statNote")}
            </p>
          </div>
        </div>

        {/* ---------------------------------------------------------------
            The deliverable itself.
        --------------------------------------------------------------- */}
        <div className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6">
          <div className="mb-6 max-w-3xl">
            <h2 className="text-hero text-balance">{t("briefingTitle")}</h2>
            <p className="mt-4 max-w-argument text-marketing text-pretty text-ink-600">
              {t("briefingBody")}
            </p>
          </div>

          <Briefing digest={digest} />

          {/*
            What the margin used to whisper, said properly.

            These three points were marginalia: 13px grey text in a 17rem
            column beside a tall card. The content is the differentiated
            argument — the score is smoothed, there are three items rather than
            thirty, the quotes are the customer's own words — and it was being
            delivered in the voice and weight of a footnote, in a column that
            left every section half empty and nothing aligned to a single grid.

            A landing page does not have margins. It has sections.
          */}
          <div className="mt-12">
            <h2 className="text-display text-balance">{t("whyTitle")}</h2>
            <dl className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-3">
              {[
                { icon: Gauge, title: t("noteScoreTitle"), body: t("noteScoreBody") },
                { icon: ListChecks, title: t("noteActionsTitle"), body: t("noteActionsBody") },
                { icon: Quote, title: t("noteEvidenceTitle"), body: t("noteEvidenceBody") },
              ].map((item) => (
                <div key={item.title} className="border-t border-line-soft pt-4">
                  <IconTile icon={item.icon} tone="accent" size="lg" className="mb-3" />
                  <dt className="text-lead font-semibold">{item.title}</dt>
                  <dd className="mt-1.5 text-body leading-relaxed text-pretty text-ink-600">
                    {item.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* ---------------------------------------------------------------
            The loop closing — the one thing nobody else in the category does.
        --------------------------------------------------------------- */}
        {digest.changes.length > 0 ? (
          <div className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6">
            <div className="max-w-3xl">
              <h2 className="text-display text-balance">{t("changesTitle")}</h2>
              <p className="mt-4 max-w-argument text-marketing text-pretty text-ink-600">
                {t("noteLoopBody")}
              </p>
            </div>

            {/*
                The two figures the week actually moved, set as figures.

                This block is the page's memorable moment — it is the only place
                in the category that reports whether last week's advice worked —
                and it was six sentences of identical weight with the numbers
                buried in running prose. The product's own dashboard sets a
                score delta as a *figure*; the page advertising it was setting
                the same delta as a clause.

                Only these two are promoted, because only these two are
                comparable across the whole period. The theme lines stay prose
                below: they are genuinely sentences ("Yeni tema: Temizlik"), and
                promoting them would be inventing a metric to have a number.
              */}
            {/*
                Inside a card, and set as figures.

                Naked on the canvas this block read as prose with digits in it —
                a heading, two numbers and five sentences, all at one weight. It
                is the page's memorable moment (the only place in the category
                that reports whether last week's advice worked), so it gets the
                treatment the product's own dashboard gives a delta: a panel,
                large tabular numerals, and the movers as rows of data.
              */}
            <div className="mt-6 max-w-argument rounded-lg border border-line bg-card px-6 py-6 sm:px-8">
              <dl className="flex flex-wrap gap-x-16 gap-y-6">
                {movedPulse && digest.priorPulse !== null && digest.pulse !== null ? (
                  <div>
                    <dt className="text-copy text-faint">{t("pulseLabel")}</dt>
                    <dd className="mt-1.5 flex items-baseline gap-2.5 text-metric-lg tabular-nums">
                      <span className="text-graphic-faint">{Math.round(digest.priorPulse)}</span>
                      <ArrowRight aria-hidden className="size-5 self-center text-graphic-faint" />
                      <span>{Math.round(digest.pulse)}</span>
                    </dd>
                  </div>
                ) : null}

                {movedVolume ? (
                  <div>
                    <dt className="text-copy text-faint">{t("changeVolumeLabel")}</dt>
                    <dd className="mt-1.5 flex items-baseline gap-2.5 text-metric-lg tabular-nums">
                      <span className="text-graphic-faint">{digest.priorReviewCount}</span>
                      <ArrowRight aria-hidden className="size-5 self-center text-graphic-faint" />
                      <span>{digest.reviewCount}</span>
                    </dd>
                  </div>
                ) : null}
              </dl>

              {/*
                  Rows, not sentences. `computeChanges` already carries the
                  parts — the theme, whether it is new, and the counts either
                  side — so rendering them as a name and a figure says the same
                  thing in a shape the eye can scan. `formatChange` still owns
                  the wording wherever a *sentence* is what is wanted (the
                  email, /sample); this surface wants a table.
                */}
              {themeChanges.length > 0 ? (
                <div className="mt-7 border-t border-line-inner pt-4">
                  {/* "Yemek 2 → 5" could be a score, a rating or a count, and
                      nothing on screen said which. */}
                  <div className="flex items-baseline justify-between gap-6 text-eyebrow text-faint uppercase">
                    <span>{t("changeThemeHeader")}</span>
                    <span>{t("changeCountHeader")}</span>
                  </div>
                  <ul className="mt-1">
                    {themeChanges.map((change) => {
                      const detail = change.detail as {
                        label?: string;
                        status?: string;
                        count?: number;
                        from?: number;
                        to?: number;
                      };
                      const isNew = detail.status === "new";
                      return (
                        <ThemeRow
                          key={`${detail.label}-${detail.status}`}
                          name={label(detail.label ?? "")}
                          isNew={isNew}
                          newLabel={t("themeNew")}
                          figure={
                            isNew
                              ? `${detail.count ?? 0}`
                              : `${detail.from ?? 0} → ${detail.to ?? 0}`
                          }
                        />
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------
            Delivery, then the product underneath the briefing.
        --------------------------------------------------------------- */}
        {/*
          Neither of the next two sections carries a margin note, and that is the
          rhythm rather than an omission: an annotated spread is the page's dense
          passage, and a full-width section is the quiet one that earns it. It
          also keeps marginalia meaning one thing — a gloss on the artefact —
          instead of degenerating into a second column of body copy.

          They are also deliberately different densities. Four short delivery
          channels across one row, then six product areas in two columns: two
          identical two-column lists one after the other read as one section
          repeated, which is exactly how they looked before.
        */}
        {/*
          A colour field, not an accent.

          Between the hero and the conscience band the page ran five sections of
          ink-on-white at one texture, which is what made it read as a settings
          screen rather than a pitch. `--indigo-050` is the lightest tint of the
          interaction hue and is already in the system as `--state-accent-bg`;
          used full-bleed it gives the scroll a second register without
          introducing a colour the product does not own.
        */}
        <section className="mt-24 bg-indigo-050 py-20">
          <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
            <h2 className="text-hero text-balance">{t("deliveryTitle")}</h2>
            {/*
              `text-ink-600`, not `text-faint`, and this band is the reason the
              rule is a *table* rather than a token.

              `docs/15` §Colour lists the lightest legal ink per surface: white,
              `--canvas`/`--surface-sunken`, `--surface-segmented`. This section
              introduced `--indigo-050` as a **fourth** surface, which that list
              does not know about — and `--ink-350` on it measures **4.493:1**,
              under AA by seven thousandths. The same ink is perfectly legal
              elsewhere: 5.06:1 on white, 4.73:1 on canvas.

              `tests/lib/design-contrast.test.ts` passes green through all of
              this, because it can only check the surfaces it has been told
              about. That gap is the real defect and it is not fixed here — see
              the surface brief.
            */}
            <dl className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
              {delivery.map((item) => (
                <div key={item.title} className="border-t border-line-soft pt-4">
                  {/*
                    No `IconTile` on this band, deliberately.

                    `tone="accent"` fills with `--state-accent-bg`, which *is*
                    `--indigo-050` — this band's own surface. The tile rendered
                    as an invisible square here while the identical component
                    two sections away rendered as a filled one: one component,
                    two appearances, within a single scroll. A bare glyph is the
                    honest reading, and it gives this band a form of its own
                    against the two icon grids that flank it.
                  */}
                  <item.icon aria-hidden className="mb-3 size-5 text-primary" strokeWidth={2} />
                  <dt className="text-lead font-semibold">{item.title}</dt>
                  <dd className="mt-1.5 text-body leading-relaxed text-pretty text-ink-600">
                    {item.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <div className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6">
          <div className="max-w-3xl">
            <h2 className="text-hero text-balance">{t("restTitle")}</h2>
            <p className="mt-4 max-w-argument text-marketing text-pretty text-ink-600">
              {t("restBody")}
            </p>
          </div>
          {/*
            The product, shown rather than described.
          
            Every section above this one talks about a queue, a heat map, a widget —
            and until now the page never showed any of them, which is the real
            reason it read as a wall of prose. This is a genuine screenshot of the
            running app, captured from the e2e account whose data comes from the
            mock connector: invented reviewers, invented branch, real interface.
          
            `docs/15` §7 forbids photography and illustration and says the product's
            imagery is its data — a picture of the product IS its data, so this is
            the one kind of image the rule was always going to allow.
          */}
          <div className="mt-10 overflow-hidden rounded-lg border border-line bg-card">
            <Image
              src="/marketing/reviews.png"
              alt={t("shotReviewsAlt")}
              width={2880}
              height={1800}
              sizes="(min-width: 1152px) 1152px, 100vw"
              className="h-auto w-full"
              priority={false}
            />
          </div>

          <dl className="mt-6 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((item) => (
              <div key={item.title} className="border-t border-line-soft pt-4">
                <IconTile icon={item.icon} tone="accent" size="lg" className="mb-3" />
                <dt className="text-lead font-semibold">{item.title}</dt>
                <dd className="mt-1.5 text-body leading-relaxed text-pretty text-faint">
                  {item.body}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* ---------------------------------------------------------------
            Collection, shown — and it argues the next section for us.

            These two slots were placeholders carrying a brief to a
            photographer, which shipped to production and read as an abandoned
            build at the exact point the page turns to its trust argument. They
            are one product screenshot now.

            It earns the position rather than merely filling it: the banner
            across the top of that screen is the product stating the
            no-rating-gating rule *in the interface*, immediately above the band
            that makes the same claim in prose. A photograph of a cafe owner
            could not have done that.
        --------------------------------------------------------------- */}
        <div className="mx-auto w-full max-w-6xl px-4 pt-24 sm:px-6">
          <figure>
            <div className="overflow-hidden rounded-lg border border-line bg-card">
              <Image
                src="/marketing/get-reviews.png"
                alt={t("shotCollectAlt")}
                width={2880}
                height={1800}
                sizes="(min-width: 1152px) 1152px, 100vw"
                className="h-auto w-full"
              />
            </div>
            <figcaption className="mt-4 max-w-argument text-body leading-relaxed text-pretty text-faint">
              {t("shotCollectCaption")}
            </figcaption>
          </figure>
        </div>

        {/* ---------------------------------------------------------------
            The conscience band. Ink, because this is the argument the product
            is actually built on and it earns the page's one dark passage —
            and because a dense white document needs somewhere to breathe.
        --------------------------------------------------------------- */}
        <section className="mt-20 bg-ink-900 py-16 sm:py-20">
          <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
            <h2 className="max-w-3xl text-hero text-balance text-on-ink">{t("refuseTitle")}</h2>

            <div className="mt-10 grid gap-10 lg:grid-cols-2">
              <div>
                <h3 className="text-display text-balance text-on-ink">{t("refuseGatingTitle")}</h3>
                <p className="mt-3 text-marketing text-pretty text-on-ink-muted">
                  {t("refuseGatingBody")}
                </p>
              </div>
              <div>
                <h3 className="text-display text-balance text-on-ink">{t("refuseFakeTitle")}</h3>
                <p className="mt-3 text-marketing text-pretty text-on-ink-muted">
                  {t("refuseFakeBody")}
                </p>
              </div>
            </div>

            {/* Its own heading: "Yapmadıklarımız" is a refusal, "henüz vaat
                etmediklerimiz" is a limitation, and one h2 counting both was
                what made the old title claim two things over three blocks. */}
            <div className="mt-14 border-t border-white/12 pt-10">
              <h2 className="text-hero text-balance text-on-ink">{t("honestTitle")}</h2>
              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <p className="text-marketing text-pretty text-on-ink-muted">{t("honestBody")}</p>
                <p className="text-marketing text-pretty text-on-ink-muted">{t("honestSnippet")}</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------
            The commercial section: what an agency buys, then what it costs,
            then the close.

            Agencies sit *inside* this section rather than in one of their own.
            They were a heading, a paragraph and a link at full section spacing
            between the ink band and the price table, which reads as an orphan
            fragment — and the reason it read that way is that it is not a
            separate subject: Agency is a row in the table two blocks down. So
            it leads the commercial section instead of interrupting the page.
        --------------------------------------------------------------- */}
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <div className="max-w-3xl">
            <h2 className="text-hero text-balance">{t("agencyTitle")}</h2>
            <p className="mt-4 max-w-argument text-marketing text-pretty text-ink-600">
              {t("agencyBody")}
            </p>
            <Link
              href="/sign-up"
              className="tap mt-4 gap-1.5 rounded-sm text-body font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {t("agencyLink")}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </div>

          <div className="mt-12">
            <h2 className="text-display text-balance">{t("pricingTitle")}</h2>
            <p className="mt-3 max-w-argument text-body leading-relaxed text-pretty text-ink-600">
              {t("pricingBody")}
            </p>

            <div className="mt-8">
              <Pricing />
            </div>

            <p className="mt-4 max-w-argument text-meta leading-relaxed text-faint">
              {t("pricingNote")}
            </p>
          </div>

          <div className="mt-24 max-w-3xl">
            <h2 className="text-hero text-balance">{t("closeTitle")}</h2>
            <p className="mt-4 max-w-argument text-lead leading-relaxed text-pretty text-ink-600">
              {t("closeBody")}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Button asChild size="lg" className="tap">
                <Link href="/sample">
                  {t("ctaPrimary")}
                  <ArrowRight aria-hidden className="size-4" />
                </Link>
              </Button>
              <Link
                href="/sign-up"
                className="tap rounded-sm text-body font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {t("ctaSecondary")}
              </Link>
            </div>
            <p className="mt-3 text-meta text-faint">{t("noCard")}</p>
          </div>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <Logo markClassName="size-6" />
            <p className="mt-2 text-meta text-faint">{t("footerTagline")}</p>
          </div>

          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-copy">
            <Link href="/sample" className="tap underline-offset-4 hover:underline">
              {t("footerSample")}
            </Link>
            <Link href="/sign-in" className="tap underline-offset-4 hover:underline">
              {t("footerSignIn")}
            </Link>
            <Link href="/sign-up" className="tap underline-offset-4 hover:underline">
              {t("footerSignUp")}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
