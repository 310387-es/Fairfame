import type { WindowReview } from "./metrics.ts";

/**
 * The demo corpus behind the public sample digest (P1a-T10).
 *
 * **Invented, not borrowed.** A lead magnet that showed a real customer's words
 * to an anonymous visitor would be a disclosure, so none of this comes from the
 * database — not from the seed data, not from a tenant, not from a real place.
 * The business does not exist and neither do the reviewers.
 *
 * Written to look like a fortnight at a genuine Istanbul café: mostly warm,
 * with two threads of real trouble (waiting times and the toilets) that a
 * digest can find and turn into work. A demo where everything is fine
 * demonstrates nothing, and one where everything is broken is not believable.
 *
 * Topics are hand-assigned rather than generated, so the sample is stable copy
 * a marketing page can be designed against — the *pipeline* is what is being
 * demonstrated, not this week's model output.
 */

/** Anchors the relative dates so the sample never says "3 months ago". */
export const SAMPLE_WINDOW_DAYS = 14;

type SampleSeed = {
  daysAgo: number;
  rating: number;
  text: string;
  language: "tr" | "en";
  sentiment: "positive" | "neutral" | "negative";
  score: number;
  topics: string[];
  /**
   * Canonical themes (W3.2), as `analyze_review@3` would return them.
   *
   * The corpus predates the taxonomy and carried only free tags, so the sample
   * briefing — the public marketing page — showed "bekleme süresi" under an
   * English action. Two seeds are deliberately left with none: `çalışma` and
   * `çalışma saatleri` have no canonical key, and a corpus where every review
   * maps cleanly would demonstrate a completeness the vocabulary does not have.
   */
  themes: string[];
  hasReply?: boolean;
};

const SEEDS: SampleSeed[] = [
  {
    daysAgo: 1,
    rating: 2,
    text: "Kahvesi güzel ama siparişimiz 30 dakikada geldi. Cumartesi öğlen çok kalabalık ve tek garson var gibi.",
    language: "tr",
    sentiment: "negative",
    score: -0.7,
    topics: ["bekleme süresi", "personel"],
    themes: ["wait_time", "staff"],
  },
  {
    daysAgo: 2,
    rating: 5,
    text: "Filtre kahveleri şehirdeki en iyilerden. Barista ne istediğimi sordu ve tam istediğim gibi demledi.",
    language: "tr",
    sentiment: "positive",
    score: 0.9,
    topics: ["kahve", "personel"],
    themes: ["product_quality", "staff"],
  },
  {
    daysAgo: 2,
    rating: 1,
    text: "Tuvalet berbat durumdaydı, sabun yoktu ve zemin ıslaktı. Yiyecek satan bir yer için kabul edilemez.",
    language: "tr",
    sentiment: "negative",
    score: -0.9,
    topics: ["temizlik", "tuvalet"],
    themes: ["cleanliness"],
  },
  {
    daysAgo: 3,
    rating: 5,
    text: "The breakfast plate is enormous and everything on it was fresh. Easily worth the price.",
    language: "en",
    sentiment: "positive",
    score: 0.9,
    topics: ["breakfast", "price"],
    themes: ["food_quality", "price"],
  },
  {
    daysAgo: 4,
    rating: 4,
    text: "Sakin bir köşe bulup iki saat çalıştım, kimse rahatsız etmedi. Priz sayısı biraz az ama.",
    language: "tr",
    sentiment: "positive",
    score: 0.5,
    topics: ["ortam", "çalışma"],
    themes: ["ambience"],
  },
  {
    daysAgo: 5,
    rating: 2,
    text: "Kahvaltı için 40 dakika bekledik, sonra da yumurtalar soğuk geldi. Ekip özür diledi en azından.",
    language: "tr",
    sentiment: "negative",
    score: -0.6,
    topics: ["bekleme süresi", "kahvaltı"],
    themes: ["wait_time", "food_quality"],
    hasReply: true,
  },
  {
    daysAgo: 6,
    rating: 5,
    text: "Personel çok sıcakkanlı. Köpeğimize su getirdiler, sormadan.",
    language: "tr",
    sentiment: "positive",
    score: 0.95,
    topics: ["personel"],
    themes: ["staff"],
  },
  {
    daysAgo: 7,
    rating: 3,
    text: "Coffee is good, music is far too loud for a Sunday morning. Had to move outside to hear my friend.",
    language: "en",
    sentiment: "neutral",
    score: -0.2,
    topics: ["müzik", "coffee"],
    themes: ["ambience", "product_quality"],
  },
  {
    daysAgo: 8,
    rating: 5,
    text: "Cheesecake'i ev yapımı gerçekten, fark ediliyor. Ayrıca fiyatlar bu semtte gayet makul.",
    language: "tr",
    sentiment: "positive",
    score: 0.85,
    topics: ["tatlı", "fiyat"],
    themes: ["food_quality", "price"],
  },
  {
    daysAgo: 9,
    rating: 1,
    text: "Toilets were out of order again and nobody mentioned it until we asked. Second visit in a row.",
    language: "en",
    sentiment: "negative",
    score: -0.85,
    topics: ["cleanliness", "toilets"],
    themes: ["cleanliness"],
  },
  {
    daysAgo: 10,
    rating: 4,
    text: "Servis biraz yavaş ama yemekler geldiğinde her şey affoluyor. Menemen özellikle iyi.",
    language: "tr",
    sentiment: "positive",
    score: 0.45,
    topics: ["bekleme süresi", "yemek"],
    themes: ["wait_time", "food_quality"],
  },
  {
    daysAgo: 11,
    rating: 5,
    text: "Staff remembered my order from last week. Small thing, but it is why I keep coming back.",
    language: "en",
    sentiment: "positive",
    score: 0.9,
    topics: ["staff"],
    themes: ["staff"],
  },
  {
    daysAgo: 12,
    rating: 3,
    text: "Terası güzel ama masalar birbirine çok yakın, yan masanın konuşmasını dinlemek zorunda kaldık.",
    language: "tr",
    sentiment: "neutral",
    score: -0.1,
    topics: ["ortam", "gürültü"],
    themes: ["ambience"],
  },
  {
    daysAgo: 13,
    rating: 5,
    text: "Sabah 8'de açık olması harika, kahvaltıyı iş öncesi yetiştirebiliyorum.",
    language: "tr",
    sentiment: "positive",
    score: 0.8,
    topics: ["kahvaltı", "çalışma saatleri"],
    themes: ["food_quality"],
  },
];

/** The prior fortnight, so the sample can show movement rather than a snapshot. */
const PRIOR_SEEDS: SampleSeed[] = [
  {
    daysAgo: 16,
    rating: 5,
    text: "Her şey harikaydı, hızlı ve güler yüzlü.",
    language: "tr",
    sentiment: "positive",
    score: 0.9,
    topics: ["personel", "bekleme süresi"],
    themes: ["staff", "wait_time"],
  },
  {
    daysAgo: 18,
    rating: 4,
    text: "Kahve iyi, tatlılar da taze.",
    language: "tr",
    sentiment: "positive",
    score: 0.7,
    topics: ["kahve", "tatlı"],
    themes: ["product_quality", "food_quality"],
  },
  {
    daysAgo: 20,
    rating: 5,
    text: "Great flat white and a quiet corner. Nothing to fault.",
    language: "en",
    sentiment: "positive",
    score: 0.9,
    topics: ["coffee", "ortam"],
    themes: ["product_quality", "ambience"],
  },
  {
    daysAgo: 22,
    rating: 3,
    text: "Biraz beklettiler ama sorun değil.",
    language: "tr",
    sentiment: "neutral",
    score: 0.1,
    topics: ["bekleme süresi"],
    themes: ["wait_time"],
  },
  {
    daysAgo: 24,
    rating: 5,
    text: "Kahvaltı tabağı yine dolu dolu.",
    language: "tr",
    sentiment: "positive",
    score: 0.85,
    topics: ["kahvaltı"],
    themes: ["food_quality"],
  },
];

function toReviews(seeds: SampleSeed[], now: Date): WindowReview[] {
  return seeds.map((seed, index) => ({
    id: `sample-${seed.daysAgo}-${index}`,
    rating: seed.rating,
    text: seed.text,
    language: seed.language,
    postedAt: new Date(now.getTime() - seed.daysAgo * 24 * 60 * 60 * 1000),
    sentiment: seed.sentiment,
    sentimentScore: seed.score,
    topics: seed.topics,
    themes: seed.themes,
    // No vectors: the sample must not need an embedding call to render, so
    // theme merging is left to the identical-slug pass. `personel` and `staff`
    // therefore stay separate here, which is the honest behaviour without
    // embeddings rather than a staged result.
    embedding: null,
    hasReply: seed.hasReply ?? false,
  }));
}

export const SAMPLE_BUSINESS = "Kahve Molası";
export const SAMPLE_LOCATION = "Moda";

export function sampleReviews(now: Date): WindowReview[] {
  return toReviews(SEEDS, now);
}

export function samplePriorReviews(now: Date): WindowReview[] {
  return toReviews(PRIOR_SEEDS, now);
}
