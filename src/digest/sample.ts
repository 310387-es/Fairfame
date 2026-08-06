import { z } from "zod";
import { runAi } from "../ai/client.ts";
import { boundOutput } from "../ai/guardrails.ts";
import type { Locale } from "../i18n/config.ts";
import { childLogger } from "../lib/logger.ts";
import {
  digestPrompt,
  DIGEST_ACTION_COUNT,
  MAX_ACTION_CHARS,
  MAX_HEADLINE_CHARS,
  MAX_SUMMARY_CHARS,
} from "../prompts/index.ts";
import {
  clusterThemes,
  computeChanges,
  computePulse,
  rawPulse,
  type ThemeCluster,
  type WindowChange,
} from "./metrics.ts";
import {
  SAMPLE_BUSINESS,
  SAMPLE_LOCATION,
  SAMPLE_WINDOW_DAYS,
  samplePriorReviews,
  sampleReviews,
} from "./sample-data.ts";

/**
 * The public sample digest (P1a-T10).
 *
 * A prospect sees what the product produces before creating an account — PRD
 * D5. It runs the *same* metrics and the *same* prompt as a real digest, over
 * an invented café, and it does so **without touching the database at all**.
 *
 * That is only possible because the computation in ./metrics.ts is pure. If the
 * pulse and the clustering had been written inside the tenant-bound pipeline,
 * this page would have needed a fake organization, a fake location and a set of
 * rows an anonymous visitor could somehow read — which is the shape of an
 * accident waiting to leak a real tenant's reviews.
 *
 * Two safeguards matter more than the rendering:
 *
 *   - **The corpus is invented** (see ./sample-data.ts). No seeded data, no
 *     tenant rows. A lead magnet built from a real customer's words would be a
 *     disclosure, however anonymised it looked.
 *   - **A visitor cannot trigger a model call.** The briefing is composed at
 *     most once per locale per TTL and cached in the process. Otherwise a
 *     public URL is an unauthenticated way to spend the AI budget, and a bored
 *     script is all it takes.
 */

const log = childLogger({ module: "digest/sample" });

/**
 * How long a composed sample is reused.
 *
 * Long, because the corpus is fixed: recomposing changes the wording and
 * nothing else. An hour keeps a deploy's first visitor from waiting on a model
 * while still letting a prompt change appear without a restart.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

export type SampleDigest = {
  business: string;
  location: string;
  periodDays: number;
  pulse: number | null;
  priorPulse: number | null;
  delta: number | null;
  reviewCount: number;
  priorReviewCount: number;
  themes: {
    label: string;
    count: number;
    positive: number;
    negative: number;
    quotes: { text: string; rating: number | null }[];
  }[];
  changes: WindowChange[];
  headline: string;
  summary: string;
  callouts: string[];
  actions: { position: number; text: string; theme: string }[];
  /** True when the briefing is the written-in fallback rather than composed. */
  fallback: boolean;
};

const composedSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  callouts: z.array(z.string()).max(3).default([]),
  actions: z
    .array(z.object({ text: z.string().min(1), theme: z.string() }))
    .min(DIGEST_ACTION_COUNT)
    .max(DIGEST_ACTION_COUNT),
});

type Composed = z.infer<typeof composedSchema>;

/**
 * A written briefing for when the model is unreachable.
 *
 * The page is marketing: it must render on a bad day. Numbers still come from
 * the computed metrics — only the prose is canned — so a visitor never sees a
 * figure that disagrees with the themes beside it.
 */
const FALLBACK: Record<Locale, Composed> = {
  tr: {
    headline: "Bekleme süresi bu hafta en çok konuşulan konu oldu",
    summary:
      "Müşteriler kahveyi ve ekibi övmeye devam ediyor, ancak hafta sonu yoğunluğunda sipariş süreleri belirgin şekilde uzamış. Tuvalet temizliği ikinci kez ayrı ayrı iki müşteri tarafından dile getirilmiş.",
    callouts: ["Barista'nın ilgisi", "Kahvaltı tabağının bolluğu"],
    actions: [
      {
        text: "Cumartesi ve pazar öğlen saatlerine bir kişi daha planlayın; şikayetlerin tamamı bu iki aralıkta.",
        theme: "bekleme süresi",
      },
      {
        text: "Tuvalet kontrolünü saatlik bir listeye bağlayın ve sabun stoğunu vardiya başında kontrol edin.",
        theme: "temizlik",
      },
      {
        text: "Pazar sabahı müzik seviyesini düşürün; iki müşteri konuşamadıklarını yazmış.",
        theme: "müzik",
      },
    ],
  },
  en: {
    headline: "Waiting times were the week's dominant theme",
    summary:
      "Customers keep praising the coffee and the team, but order times stretched noticeably at weekend peaks. Toilet cleanliness came up separately from two different customers.",
    callouts: ["The barista's attention", "The size of the breakfast plate"],
    actions: [
      {
        text: "Roster one more person for Saturday and Sunday midday — every complaint falls in those two windows.",
        theme: "bekleme süresi",
      },
      {
        text: "Put the toilets on an hourly check and confirm soap stock at the start of each shift.",
        theme: "temizlik",
      },
      {
        text: "Turn the music down on Sunday mornings; two customers wrote that they could not hold a conversation.",
        theme: "müzik",
      },
    ],
  },
};

type CacheEntry = { at: number; digest: SampleDigest };
const cache = new Map<Locale, CacheEntry>();

/** Test seam — the cache would otherwise make a second assertion meaningless. */
export function clearSampleCache(): void {
  cache.clear();
}

/** The computed half. Pure, instant, and identical on every call. */
function computeSample(now: Date) {
  const reviews = sampleReviews(now);
  const prior = samplePriorReviews(now);

  const themes = clusterThemes(reviews, { limit: 6 });
  const priorThemes = clusterThemes(prior, { limit: 6 });
  /**
   * Smoothed toward both fortnights together (W3.3), the same shape the real
   * pipeline uses. The sample is a *public demonstration* of what the product
   * shows, so it has to be scored the way the product scores — an unsmoothed
   * sample would advertise a number the app would never print.
   */
  const baseline = rawPulse([...reviews, ...prior]);
  const pulse = computePulse(reviews, { prior: baseline });
  const priorPulse = computePulse(prior, { prior: baseline });

  return {
    reviews,
    prior,
    themes,
    pulse,
    priorPulse,
    changes: computeChanges({
      pulse,
      priorPulse,
      reviewCount: reviews.length,
      priorReviewCount: prior.length,
      themes,
      priorThemes,
    }),
  };
}

function quotesFor(theme: ThemeCluster, reviews: ReturnType<typeof sampleReviews>) {
  const byId = new Map(reviews.map((review) => [review.id, review]));

  return (
    theme.reviewIds
      .map((id) => byId.get(id))
      .filter((review): review is (typeof reviews)[number] => review !== undefined)
      // Worst first, as in the real pipeline: a theme's harshest review is the
      // one an action has to answer.
      .sort((left, right) => (left.sentimentScore ?? 0) - (right.sentimentScore ?? 0))
      .slice(0, 2)
      .map((review) => ({ text: review.text ?? "", rating: review.rating }))
  );
}

export type SampleOptions = {
  locale: Locale;
  now?: Date;
  /** Skips the model entirely. Used by tests and by the fallback path. */
  offline?: boolean;
};

/**
 * Builds (or returns a cached) sample digest.
 *
 * Never throws. A marketing page that 500s because a third party is slow is
 * worse than one showing a written briefing over real numbers.
 */
export async function getSampleDigest(options: SampleOptions): Promise<SampleDigest> {
  const { locale, now = new Date() } = options;

  const cached = cache.get(locale);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.digest;

  const computed = computeSample(now);

  const themes = computed.themes.map((theme) => ({
    label: theme.label,
    count: theme.reviewCount,
    positive: theme.positive,
    negative: theme.negative,
    quotes: quotesFor(theme, computed.reviews),
  }));

  let composed: Composed = FALLBACK[locale];
  let fallback = true;

  if (!options.offline) {
    try {
      const prompt = digestPrompt({
        locale,
        businessName: SAMPLE_BUSINESS,
        locationName: SAMPLE_LOCATION,
        periodLabel: `last ${SAMPLE_WINDOW_DAYS} days`,
        pulse: computed.pulse,
        priorPulse: computed.priorPulse,
        reviewCount: computed.reviews.length,
        priorReviewCount: computed.prior.length,
        themes: themes.map((theme) => ({
          label: theme.label,
          count: theme.count,
          positive: theme.positive,
          negative: theme.negative,
        })),
        changes: computed.changes,
        quotes: themes.flatMap((theme) =>
          theme.quotes.map((quote) => ({ theme: theme.label, text: quote.text })),
        ),
      });

      const { response } = await runAi({
        // No tenant: this is an anonymous marketing page. See RunAiArgs.
        organizationId: null,
        task: "digest",
        prompt,
      });

      composed = composedSchema.parse(JSON.parse(extractJson(response.text)));
      fallback = false;
    } catch (error) {
      log.warn({ locale, err: error }, "Sample digest fell back to the written briefing");
    }
  }

  const digest: SampleDigest = {
    business: SAMPLE_BUSINESS,
    location: SAMPLE_LOCATION,
    periodDays: SAMPLE_WINDOW_DAYS,
    pulse: computed.pulse,
    priorPulse: computed.priorPulse,
    delta:
      computed.pulse !== null && computed.priorPulse !== null
        ? Number((computed.pulse - computed.priorPulse).toFixed(1))
        : null,
    reviewCount: computed.reviews.length,
    priorReviewCount: computed.prior.length,
    themes,
    changes: computed.changes,
    headline: boundOutput(composed.headline, MAX_HEADLINE_CHARS),
    summary: boundOutput(composed.summary, MAX_SUMMARY_CHARS),
    callouts: composed.callouts.map((callout) => boundOutput(callout, MAX_ACTION_CHARS)),
    actions: composed.actions.slice(0, DIGEST_ACTION_COUNT).map((action, index) => ({
      position: index + 1,
      text: boundOutput(action.text, MAX_ACTION_CHARS),
      // Pinned to a theme that exists, exactly as the real pipeline does, so
      // the sample cannot advertise evidence it does not have.
      theme: themes.some((theme) => theme.label === action.theme)
        ? action.theme
        : (themes[0]?.label ?? ""),
    })),
    fallback,
  };

  cache.set(locale, { at: Date.now(), digest });
  return digest;
}

/** Same fence-tolerant extraction the analysis and digest parsers use. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1];

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
