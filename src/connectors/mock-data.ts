/**
 * Realistic TR + EN review generation for the MockConnector.
 *
 * Deterministic by design. The same location always produces the same corpus,
 * with the same `source_review_id`s, so a second sync is a genuine dedup test
 * rather than a fresh batch of rows that happens to look similar. It also
 * means fixtures are reproducible across machines and CI runs.
 */

/** xmur3 string hash → 32-bit seed. */
function hashSeed(value: string): number {
  let h = 1779033703 ^ value.length;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 — small, fast, good enough for fixture data. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("cannot pick from an empty list");
  return item;
}

export const THEMES = [
  "service",
  "food_quality",
  "cleanliness",
  "price",
  "wait_time",
  "staff",
  "ambience",
  "parking",
  "product_quality",
  "stock_availability",
  "room_comfort",
  "treatment_outcome",
] as const;

export type Theme = (typeof THEMES)[number];

/**
 * Which of those a business of a given kind actually gets reviewed on (A22-C7).
 *
 * The corpus was one list for everybody, so picking **Kafe** during onboarding
 * produced complaints about dry chicken, lentil soup and the valet — a demo
 * that reads as somebody else's restaurant. The sample workspace is the first
 * thing a new account sees and the strongest argument the product makes, so
 * whether it looks like *their* business is not decoration.
 *
 * Kept beside the phrases rather than derived from `CANONICAL_THEMES`, and that
 * is deliberate: this list is bounded by what there is *writing* for. A theme
 * the taxonomy offers but this bank has no sentences for would produce an empty
 * review, so the constraint here is the corpus, not the vocabulary. Where the
 * two agree they agree because somebody wrote the lines.
 */
const VERTICAL_THEMES: Record<string, readonly Theme[]> = {
  cafe: ["service", "food_quality", "cleanliness", "price", "wait_time", "staff", "ambience"],
  restaurant: [
    "service",
    "food_quality",
    "cleanliness",
    "price",
    "wait_time",
    "staff",
    "ambience",
    "parking",
  ],
  hotel: ["service", "cleanliness", "price", "staff", "ambience", "room_comfort", "food_quality"],
  retail: [
    "service",
    "staff",
    "price",
    "cleanliness",
    "wait_time",
    "product_quality",
    "stock_availability",
  ],
  clinic: ["service", "staff", "wait_time", "price", "cleanliness", "treatment_outcome"],
  services: ["service", "staff", "wait_time", "price", "cleanliness"],
};

/** Universal only — the honest answer for a business we know nothing about. */
const DEFAULT_THEMES: readonly Theme[] = [
  "service",
  "cleanliness",
  "price",
  "wait_time",
  "staff",
  "ambience",
];

function themesFor(vertical: string | null | undefined): readonly Theme[] {
  return (vertical && VERTICAL_THEMES[vertical]) || DEFAULT_THEMES;
}
export type Sentiment = "positive" | "neutral" | "negative";

const TR_NAMES = [
  "Ayşe Yılmaz",
  "Mehmet Demir",
  "Zeynep Kaya",
  "Mustafa Şahin",
  "Elif Çelik",
  "Ahmet Öztürk",
  "Fatma Aydın",
  "Emre Arslan",
  "Merve Doğan",
  "Burak Koç",
  "Selin Kurt",
  "Hakan Özdemir",
  "Ceren Aksoy",
  "Onur Yıldırım",
  "Gizem Polat",
  "Serkan Erdoğan",
] as const;

const EN_NAMES = [
  "James Porter",
  "Sarah Whitfield",
  "Daniel Hughes",
  "Emily Carter",
  "Michael Brennan",
  "Laura Bennett",
  "Chris Nolan",
  "Anna Fitzgerald",
  "Tom Wheeler",
  "Rachel Lindqvist",
  "Peter Mwangi",
  "Nadia Haddad",
] as const;

/** Phrases grouped by theme and sentiment, in both launch languages. */
const PHRASES: Record<
  Theme,
  Record<Sentiment, { tr: readonly string[]; en: readonly string[] }>
> = {
  service: {
    positive: {
      tr: [
        "Servis çok hızlıydı, siparişimiz 10 dakikada geldi.",
        "İlgi alaka mükemmeldi, kendimizi özel hissettik.",
      ],
      en: [
        "Service was quick and attentive from the moment we sat down.",
        "The team checked on us just the right amount — not too much.",
      ],
    },
    neutral: {
      tr: ["Servis normaldi, ne iyi ne kötü.", "Ortalama bir servis deneyimiydi."],
      en: ["Service was fine, nothing that stood out either way.", "Perfectly average service."],
    },
    negative: {
      tr: [
        "Siparişimizi almaları 20 dakika sürdü, kimse ilgilenmedi.",
        "Garsonu çağırmak için sürekli el kaldırmak zorunda kaldık.",
      ],
      en: [
        "We waited far too long before anyone took our order.",
        "Had to flag someone down three separate times.",
      ],
    },
  },
  food_quality: {
    positive: {
      tr: [
        "Yemekler taptaze, özellikle mercimek çorbası harikaydı.",
        "Kahvaltı tabağı zengindi, her şey lezzetliydi.",
      ],
      en: [
        "Food was fresh and genuinely well seasoned.",
        "The breakfast plate was generous and everything tasted homemade.",
      ],
    },
    neutral: {
      tr: ["Yemekler fena değildi ama beklediğim kadar da iyi değildi.", "Lezzet ortalamaydı."],
      en: ["The food was okay — edible but forgettable.", "Decent, not memorable."],
    },
    negative: {
      tr: [
        "Yemek soğuk geldi ve tuzu fazlaydı.",
        "Tavuk kuru ve tatsızdı, yarısını bırakmak zorunda kaldık.",
      ],
      en: ["The dish arrived lukewarm and over-salted.", "Chicken was dry — we left most of it."],
    },
  },
  cleanliness: {
    positive: {
      tr: ["Mekan tertemizdi, tuvaletler bile kusursuzdu.", "Hijyene çok dikkat ediliyor."],
      en: ["Spotless throughout, including the restrooms.", "Clearly a lot of care about hygiene."],
    },
    neutral: {
      tr: ["Temizlik idare ederdi.", "Ortalık biraz geç toplandı ama sorun değildi."],
      en: ["Cleanliness was acceptable.", "Tidying was a little slow but it was fine."],
    },
    negative: {
      tr: ["Yerler kirliydi, kimse ilgilenmiyordu.", "Tuvaletler kirliydi."],
      en: [
        "The floors were dirty and nobody seemed to be on it.",
        "The restrooms needed attention.",
      ],
    },
  },
  price: {
    positive: {
      tr: [
        "Fiyat performans açısından gayet iyi.",
        "Ödediğim paranın karşılığını fazlasıyla aldım.",
      ],
      en: ["Great value for what you get.", "Well worth what I paid."],
    },
    neutral: {
      tr: ["Fiyatlar piyasa ortalamasında.", "Ne ucuz ne pahalı."],
      en: ["Prices are about what you'd expect.", "Neither cheap nor expensive."],
    },
    negative: {
      tr: ["Bu kalite için fiyat çok yüksek.", "Aldığınız şeye göre pahalı."],
      en: ["Overpriced for what it is.", "Expensive for what you actually get."],
    },
  },
  wait_time: {
    positive: {
      tr: ["Hiç beklemeden işimiz görüldü.", "Randevumuz dakikasında başladı."],
      en: ["We were seen straight away.", "Our appointment started right on time."],
    },
    neutral: {
      tr: ["Kısa bir bekleme oldu ama makuldü.", "10 dakika bekledik, sorun değil."],
      en: ["Short wait, nothing unreasonable.", "Waited about ten minutes."],
    },
    negative: {
      tr: ["Randevumuz olmasına rağmen 40 dakika bekledik.", "Cumartesi kuyruk çok uzundu."],
      en: [
        "Waited forty minutes despite having an appointment.",
        "The queue on Saturday was unmanageable.",
      ],
    },
  },
  staff: {
    positive: {
      tr: [
        "Personel çok güler yüzlü ve yardımseverdi.",
        "Ekip gerçekten samimi, tekrar geleceğiz.",
      ],
      en: ["Staff were warm and genuinely welcoming.", "Lovely team — we'll be back."],
    },
    neutral: {
      tr: ["Personel işini yapıyordu.", "Nazikti ama biraz mesafeliydi."],
      en: ["Staff were polite enough.", "Courteous but a little distant."],
    },
    negative: {
      tr: ["Personel ilgisizdi ve bizi görmezden geldi.", "Kaba bir karşılama ile başladık."],
      en: ["Staff seemed uninterested in helping.", "We were greeted rather rudely."],
    },
  },
  ambience: {
    positive: {
      tr: [
        "Ortam çok huzurlu, müzik seviyesi tam kıvamında.",
        "Dekorasyon çok şık, ışıklandırma güzel.",
      ],
      en: [
        "Lovely atmosphere, music at just the right level.",
        "Beautiful interior and warm lighting.",
      ],
    },
    neutral: {
      tr: ["Ortam sıradan ama rahatsız edici değil.", "Standart bir mekan atmosferi."],
      en: ["The space is plain but comfortable.", "Fairly standard atmosphere."],
    },
    negative: {
      tr: ["Müzik o kadar yüksekti ki konuşamadık.", "İçerisi çok havasız ve sıkışıktı."],
      en: ["The music was so loud we couldn't hold a conversation.", "Cramped and stuffy inside."],
    },
  },
  parking: {
    positive: {
      tr: ["Vale hizmeti var, park sorunu yaşamadık.", "Otopark geniş ve ücretsiz."],
      en: ["Valet service made parking effortless.", "Plenty of free parking."],
    },
    neutral: {
      tr: ["Park yeri bulmak biraz zaman aldı.", "Civarda ücretli otopark var."],
      en: ["Parking took a few minutes to sort out.", "Paid parking nearby."],
    },
    negative: {
      tr: ["Park yeri yok, 15 dakika tur attık.", "Otopark çok dar, manevra imkansız."],
      en: ["No parking at all — we circled for fifteen minutes.", "The car park is far too tight."],
    },
  },
  product_quality: {
    positive: {
      tr: ["Aldığım ürün beklediğimden çok daha kaliteli çıktı.", "Kumaşı ve dikişi çok iyi."],
      en: [
        "The quality is well above what I expected for the price.",
        "Solidly made — it has held up.",
      ],
    },
    neutral: {
      tr: ["Ürün fena değil, fiyatına göre normal.", "Beklediğim gibiydi, ne fazlası ne eksiği."],
      en: ["The product is fine for what it costs.", "About what I expected, no more."],
    },
    negative: {
      tr: ["İki hafta içinde bozuldu, kalitesi çok düşük.", "Ürün resimdekiyle aynı değildi."],
      en: ["It broke within a fortnight — poor quality.", "Not the same as the item pictured."],
    },
  },
  stock_availability: {
    positive: {
      tr: ["Aradığım her beden vardı, çok rahat seçtim.", "Rafta bulamadığımı depodan çıkardılar."],
      en: [
        "Every size I wanted was on the shelf.",
        "They found my size in the back without a fuss.",
      ],
    },
    neutral: {
      tr: ["Bazı bedenler yoktu ama alternatif önerdiler.", "Çeşit biraz sınırlıydı."],
      en: [
        "A couple of sizes were out, but they suggested alternatives.",
        "Choice was a bit limited.",
      ],
    },
    negative: {
      tr: [
        "Vitrindeki ürünün hiçbir bedeni yoktu, boşuna gittim.",
        "Rafların yarısı boştu, aradığımı bulamadım.",
      ],
      en: [
        "Nothing in the window was actually in stock in my size.",
        "Half the shelves were bare — a wasted trip.",
      ],
    },
  },
  room_comfort: {
    positive: {
      tr: ["Oda geniş ve sessizdi, yatak çok rahattı.", "Klima ve duş kusursuz çalışıyordu."],
      en: [
        "The room was quiet and the bed genuinely comfortable.",
        "Air conditioning and shower both faultless.",
      ],
    },
    neutral: {
      tr: ["Oda idare ederdi, biraz küçüktü.", "Yatak normaldi, uyumakta zorlanmadım."],
      en: ["The room was adequate, if small.", "Bed was fine — I slept well enough."],
    },
    negative: {
      tr: [
        "Odadan koridor sesi geliyordu, sabaha kadar uyuyamadık.",
        "Klima çalışmıyordu ve oda çok havasızdı.",
      ],
      en: [
        "Corridor noise came straight through — we barely slept.",
        "The air conditioning did not work and the room was stuffy.",
      ],
    },
  },
  treatment_outcome: {
    positive: {
      tr: [
        "Şikayetim ilk seansta geçti, çok memnun kaldım.",
        "Tedavi tam anlatıldığı gibi sonuç verdi.",
      ],
      en: [
        "My symptoms cleared after the first session.",
        "The treatment did exactly what they said it would.",
      ],
    },
    neutral: {
      tr: ["Kısmen fayda gördüm, kontrole tekrar gideceğim.", "Sonuç şimdilik ortalama."],
      en: [
        "Some improvement so far — I have a follow-up booked.",
        "Results are middling at this stage.",
      ],
    },
    negative: {
      tr: [
        "İki seans sonunda hiçbir değişiklik olmadı.",
        "Tedavi sonrası şikayetim daha da arttı.",
      ],
      en: ["Two sessions in and nothing has changed.", "I felt worse afterwards than before."],
    },
  },
};

/**
 * Sentences that are only wrong because of the *kind* of business (A22-C7).
 *
 * A café's food is coffee and a pastry, not a lentil soup and a dry chicken; a
 * shop's cleanliness is about the fitting rooms rather than a sticky table. So
 * the bank above stays the general one and this overrides the handful of themes
 * whose wording gives the wrong business away. Everything not named here — a
 * rude greeting, a forty-minute wait, an overcharge — genuinely reads the same
 * everywhere, and duplicating it per vertical would be six copies to keep in
 * step for no gain.
 */
/**
 * Tables, reservations and portions — true of a restaurant and a café, and of
 * nothing else in the product.
 *
 * These lines *were* in the universal bank, which is how a shop's demo came to
 * say "portions are generous for the price" and a clinic's "we found a table
 * without waiting". Only reading the generated corpus caught it: every theme
 * key was right, and the sentences underneath were somebody else's trade.
 */
const HOSPITALITY: Partial<typeof PHRASES> = {
  price: {
    positive: {
      tr: ["Fiyat performans açısından gayet iyi.", "Porsiyonlar büyük, fiyatlar makul."],
      en: ["Great value for what you get.", "Portions are generous for the price."],
    },
    neutral: {
      tr: ["Fiyatlar piyasa ortalamasında.", "Ne ucuz ne pahalı."],
      en: ["Prices are about what you'd expect.", "Neither cheap nor expensive."],
    },
    negative: {
      tr: ["Bu porsiyon için fiyat çok yüksek.", "Aldığınız şeye göre pahalı."],
      en: ["Overpriced for the portion size.", "Expensive for what it is."],
    },
  },
  wait_time: {
    positive: {
      tr: ["Hiç beklemeden masa bulduk.", "Rezervasyonumuz dakikasında hazırdı."],
      en: ["We were seated immediately.", "Our reservation was ready right on time."],
    },
    neutral: {
      tr: ["Kısa bir bekleme oldu ama makuldü.", "10 dakika bekledik, sorun değil."],
      en: ["Short wait, nothing unreasonable.", "Waited about ten minutes."],
    },
    negative: {
      tr: [
        "Rezervasyonumuz olmasına rağmen 40 dakika bekledik.",
        "Cumartesi akşamı kuyruk çok uzundu.",
      ],
      en: [
        "Waited forty minutes despite having a reservation.",
        "The queue on Saturday evening was unmanageable.",
      ],
    },
  },
  cleanliness: {
    positive: {
      tr: ["Mekan tertemizdi, tuvaletler bile kusursuzdu.", "Hijyene çok dikkat ediliyor."],
      en: ["Spotless throughout, including the restrooms.", "Clearly a lot of care about hygiene."],
    },
    neutral: {
      tr: ["Temizlik idare ederdi.", "Masalar biraz geç toplandı ama sorun değildi."],
      en: ["Cleanliness was acceptable.", "Tables were cleared a bit slowly but it was fine."],
    },
    negative: {
      tr: ["Masamız yapış yapıştı, silmelerini istemek zorunda kaldık.", "Tuvaletler kirliydi."],
      en: ["Our table was sticky and had to be wiped twice.", "The restrooms needed attention."],
    },
  },
};

const VERTICAL_PHRASES: Record<string, Partial<typeof PHRASES>> = {
  restaurant: HOSPITALITY,
  cafe: {
    ...HOSPITALITY,
    food_quality: {
      positive: {
        tr: [
          "Kahve çekirdeği taze, filtre kahve gerçekten iyi demlenmiş.",
          "Cheesecake ev yapımı gibiydi, kahvenin yanına tam oturdu.",
        ],
        en: [
          "The beans are fresh and the filter coffee is properly brewed.",
          "Pastries taste home-made — the cheesecake especially.",
        ],
      },
      neutral: {
        tr: ["Kahve normaldi, ne iyi ne kötü.", "Tatlılar ortalamaydı."],
        en: ["The coffee was fine, nothing special.", "Pastries were average."],
      },
      negative: {
        tr: [
          "Latte ılık geldi ve sütü fazla köpüklüydü.",
          "Kruvasan bayattı, dünden kalma gibiydi.",
        ],
        en: ["The latte arrived lukewarm and over-foamed.", "The croissant was stale."],
      },
    },
  },
  retail: {
    cleanliness: {
      positive: {
        tr: ["Mağaza tertemiz, kabinler bile düzenliydi.", "Raflar toplu ve temiz."],
        en: ["The shop is spotless, fitting rooms included.", "Shelves are tidy and clean."],
      },
      neutral: {
        tr: ["Temizlik idare ederdi.", "Kabinler biraz dağınıktı ama sorun değil."],
        en: ["Cleanliness was acceptable.", "The fitting rooms were a little untidy."],
      },
      negative: {
        tr: ["Kabinlerde yerde kıyafetler duruyordu.", "Mağaza tozluydu, raflar dağınıktı."],
        en: ["Clothes were left on the fitting-room floor.", "Dusty shelves and a messy floor."],
      },
    },
  },
  clinic: {
    cleanliness: {
      positive: {
        tr: ["Klinik tertemizdi, hijyene çok dikkat ediliyor.", "Bekleme salonu bile pırıl pırıl."],
        en: [
          "The clinic is immaculate and hygiene is clearly taken seriously.",
          "Even the waiting room is spotless.",
        ],
      },
      neutral: {
        tr: ["Temizlik yeterliydi.", "Bekleme alanı biraz kalabalıktı ama temizdi."],
        en: ["Cleanliness was adequate.", "The waiting area was busy but clean."],
      },
      negative: {
        tr: ["Bekleme salonu temiz değildi.", "Muayene odası derli toplu değildi."],
        en: ["The waiting room was not clean.", "The consulting room was untidy."],
      },
    },
  },
};

/** The bank for one theme, with the vertical's own wording where there is any. */
function phrasesFor(vertical: string | null | undefined, theme: Theme) {
  const override = vertical ? VERTICAL_PHRASES[vertical]?.[theme] : undefined;
  return override ?? PHRASES[theme];
}

const OWNER_REPLIES = {
  positive: {
    tr: [
      "Güzel yorumunuz için çok teşekkür ederiz, yine bekleriz!",
      "Değerli geri bildiriminiz için teşekkürler, sizi ağırlamak bizim için keyifti.",
    ],
    en: [
      "Thank you so much for the kind words — we hope to see you again soon!",
      "We really appreciate you taking the time to share this.",
    ],
  },
  neutral: {
    tr: ["Geri bildiriminiz için teşekkürler, önerilerinizi değerlendireceğiz."],
    en: ["Thanks for the feedback — we'll take your comments on board."],
  },
  negative: {
    tr: [
      "Yaşadığınız olumsuzluk için çok üzgünüz. Konuyu ekibimizle değerlendirip gerekli düzenlemeleri yapacağız.",
      "Geri bildiriminiz için teşekkür ederiz, bu deneyim standartlarımızı yansıtmıyor. Sizinle iletişime geçmek isteriz.",
    ],
    en: [
      "We're sorry this was your experience — it isn't the standard we hold ourselves to. We'd like to make it right.",
      "Thank you for flagging this. We've shared it with the team and are addressing it.",
    ],
  },
} as const;

function sentimentForRating(rating: number): Sentiment {
  if (rating >= 4) return "positive";
  if (rating === 3) return "neutral";
  return "negative";
}

/** Rating distribution skewed positive, as real review corpora are. */
function drawRating(random: () => number): number {
  const roll = random();
  if (roll < 0.42) return 5;
  if (roll < 0.66) return 4;
  if (roll < 0.79) return 3;
  if (roll < 0.9) return 2;
  return 1;
}

export type MockReviewPayload = {
  id: string;
  author: { name: string };
  rating: number;
  comment: string;
  language: "tr" | "en";
  createdAt: string;
  permalink: string;
  themes: Theme[];
  ownerReply?: { text: string; repliedAt: string };
};

export type CorpusOptions = {
  locationId: string;
  count: number;
  /** Reviews are spread backwards from this instant. */
  until: Date;
  /** How far back the backfill reaches. */
  spanDays?: number;
  seed?: string;
  /** Marks generated ids, so drip batches never collide with the backfill. */
  batchTag?: string;
  /**
   * What kind of business this is — `locations.category` (A22-C7).
   *
   * Decides which themes the corpus draws on and, for a handful of them, how
   * they are worded. Absent means the universal set: a demo that says nothing
   * specific is better than one that confidently describes the wrong trade.
   */
  vertical?: string | null;
  /**
   * Random backwards scatter applied to each timestamp, in milliseconds.
   *
   * Harmless across a long backfill, but it must be 0 for a short drip batch:
   * scattering a "new" review backwards can place it before the sync cursor,
   * and the incremental fetch would then never return it.
   */
  jitterMs?: number;
};

/**
 * Builds a deterministic corpus of reviews for one location.
 *
 * Ids are derived from the location and the item's index, so re-generating
 * yields byte-identical ids — which is exactly what makes dedup testable.
 */
export function generateCorpus(options: CorpusOptions): MockReviewPayload[] {
  const {
    locationId,
    count,
    until,
    spanDays = 180,
    seed = "",
    batchTag = "bf",
    jitterMs = 3_600_000,
    vertical = null,
  } = options;

  const pool = themesFor(vertical);
  const random = rng(hashSeed(`${locationId}:${seed}:${batchTag}`));
  const shortId = hashSeed(locationId).toString(36).slice(0, 6);

  const reviews: MockReviewPayload[] = [];

  for (let index = 0; index < count; index += 1) {
    const language: "tr" | "en" = random() < 0.72 ? "tr" : "en"; // Türkiye-first
    const rating = drawRating(random);
    const sentiment = sentimentForRating(rating);

    // One or two themes per review, so recurring themes emerge across the set.
    const primary = pick(random, pool);
    const themes: Theme[] = [primary];
    if (random() < 0.45) {
      const secondary = pick(random, pool);
      if (secondary !== primary) themes.push(secondary);
    }

    const comment = themes
      .map((theme) => pick(random, phrasesFor(vertical, theme)[sentiment][language]))
      .join(" ");

    // Spread backwards from `until`, newest first.
    const ageMs = Math.floor((index / Math.max(count, 1)) * spanDays * 86_400_000);
    const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
    const createdAt = new Date(until.getTime() - ageMs - jitter);

    const names = language === "tr" ? TR_NAMES : EN_NAMES;

    // Owners reply to complaints more often than to praise, as in the wild.
    const replyChance = sentiment === "negative" ? 0.6 : sentiment === "neutral" ? 0.25 : 0.35;
    const hasReply = random() < replyChance;

    reviews.push({
      id: `mock_${shortId}_${batchTag}_${index}`,
      author: { name: pick(random, names) },
      rating,
      comment,
      language,
      createdAt: createdAt.toISOString(),
      permalink: `https://mock.reviews.local/${shortId}/${batchTag}-${index}`,
      themes,
      ...(hasReply
        ? {
            ownerReply: {
              text: pick(random, OWNER_REPLIES[sentiment][language]),
              repliedAt: new Date(createdAt.getTime() + 86_400_000).toISOString(),
            },
          }
        : {}),
    });
  }

  return reviews;
}
